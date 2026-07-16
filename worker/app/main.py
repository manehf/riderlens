from __future__ import annotations

import base64
import json
import hmac
import logging
from collections import deque
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path as FilePath
from typing import Literal

os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "riderlens-matplotlib"))

# Load env vars (ANTHROPIC_API_KEY, RIDERLENS_*) from the repo root .env and worker/.env
# so the worker picks them up without shell prefixes. Existing env vars win.
try:
    from dotenv import load_dotenv

    load_dotenv(FilePath(__file__).resolve().parents[2] / ".env")
    load_dotenv(FilePath(__file__).resolve().parents[1] / ".env")
except ImportError:  # pragma: no cover - dotenv ships with pydantic-settings
    pass

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

try:
    import cv2
    import mediapipe as mp
    import numpy as np
except Exception:  # pragma: no cover - worker deps are optional in local app-only dev
    cv2 = None
    mp = None
    np = None

try:
    from supabase import create_client
except Exception:  # pragma: no cover - optional until Supabase is configured
    create_client = None


# Crash visibility: errors during processing must outlive the machine (logs
# die with scale-to-zero). DSN-gated so local dev and tests stay untouched.
# No PII: stack traces and request routes only, never rider media.
_sentry_dsn = os.getenv("SENTRY_DSN", "").strip()
if _sentry_dsn:
    import sentry_sdk

    sentry_sdk.init(
        dsn=_sentry_dsn,
        send_default_pii=False,
        traces_sample_rate=0,
        environment=os.getenv("FLY_APP_NAME", "local"),
    )

app = FastAPI(title="RiderLens Analysis Worker", version="0.2.0")
logger = logging.getLogger("uvicorn.error")
CAPTURE_JOB_LOCK = threading.Lock()

# --- Abuse containment -------------------------------------------------------
# The processing endpoints spend real money (Claude) and real CPU. Until
# accounts exist, three cheap layers bound anonymous abuse:
#   1. A client key shipped inside the app. Extractable from the binary by a
#      determined attacker, but it ends drive-by scanners and casual curl.
#      Enforcement is off until RIDERLENS_CLIENT_KEY is set, so builds already
#      in testers' hands keep working; flip the Fly secret once new builds ship.
#   2. A per-IP sliding-window rate limit (in-memory; one machine serves all).
#   3. A hard upload size cap enforced while streaming to disk.


def require_client_key(x_riderlens_key: str | None = Header(None)) -> None:
    expected = os.getenv("RIDERLENS_CLIENT_KEY", "").strip()
    if not expected:
        return
    if not x_riderlens_key or not hmac.compare_digest(x_riderlens_key, expected):
        raise HTTPException(status_code=401, detail="This endpoint requires the RiderLens app.")


RATE_BUCKETS: dict[str, deque] = {}
RATE_LOCK = threading.Lock()


def enforce_rate_limit(request: Request) -> None:
    max_requests = int(os.getenv("RIDERLENS_RATE_LIMIT_MAX", "30"))
    window_seconds = float(os.getenv("RIDERLENS_RATE_LIMIT_WINDOW_SECONDS", "3600"))
    client_ip = request.headers.get("fly-client-ip") or (request.client.host if request.client else "unknown")
    now = time.time()
    with RATE_LOCK:
        if len(RATE_BUCKETS) > 4096:
            for ip in [ip for ip, bucket in RATE_BUCKETS.items() if not bucket or now - bucket[-1] > window_seconds]:
                del RATE_BUCKETS[ip]
        bucket = RATE_BUCKETS.setdefault(client_ip, deque())
        while bucket and now - bucket[0] > window_seconds:
            bucket.popleft()
        if len(bucket) >= max_requests:
            retry_after = max(1, int(window_seconds - (now - bucket[0])))
            raise HTTPException(
                status_code=429,
                detail="Too many analyses from this connection. Try again later.",
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)


PROTECTED = [Depends(require_client_key), Depends(enforce_rate_limit)]

# Browser clients (Expo web during development, the share pages later) need
# CORS; native apps ignore it. The API holds no secrets — auth comes later
# with accounts.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
# Record responses contain compressed media encoded as base64. Gzip recovers
# most of that base64 expansion before the payload crosses a mobile network.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

SkillType = Literal["regular_jump", "bunnyhop", "manual", "wheelie", "drop"]
CropPreset = Literal["full_side_view", "rider_centered", "takeoff_landing", "vertical_social"]
Phase = Literal["approach", "compression", "takeoff", "air", "landing", "crash"]
GeometrySource = Literal["detected", "estimated"]


class AnalyzeRequest(BaseModel):
    session_id: str
    raw_video_path: str
    skill_type: SkillType = "regular_jump"
    trim_start_seconds: float = Field(default=0, ge=0)
    trim_end_seconds: float | None = Field(default=None, ge=0)
    crop_preset: CropPreset = "full_side_view"


class FramePoint(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class FrameLine(BaseModel):
    start: FramePoint
    end: FramePoint


class FrameGeometry(BaseModel):
    floor: FrameLine
    tireBaseline: FrameLine
    torso: FrameLine
    kneeUpper: FrameLine
    kneeLower: FrameLine
    landing: FrameLine


class FrameRect(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(ge=0, le=1)
    h: float = Field(ge=0, le=1)


class Metric(BaseModel):
    phase: Phase
    frameTime: float
    torsoAngle: float
    hipAngle: float
    kneeAngle: float
    elbowAngle: float
    bikePitchAngle: float
    floorAngle: float
    tireBaselineAngle: float
    landingAlignmentAngle: float
    geometrySource: GeometrySource
    geometry: FrameGeometry
    # Normalized bike bounding box from the object detector, when the bike was found in this frame.
    bikeBox: FrameRect | None = None
    confidence: float = Field(ge=0, le=1)
    # Base64 JPEG data URL of the source frame; only populated when include_frames is requested (dev UI).
    frameImage: str | None = None


class Report(BaseModel):
    summary: str
    strengths: list[str]
    improvements: list[str]
    drills: list[str]


class AnalyzeResponse(BaseModel):
    status: Literal["completed"]
    metrics: list[Metric]
    report: Report


@dataclass
class PoseFrame:
    time_seconds: float
    frame: object
    landmarks: object
    side: Literal["left", "right"]
    confidence: float


def get_supabase():
    url = os.getenv("SUPABASE_URL")
    secret_key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not secret_key or create_client is None:
        return None
    return create_client(url, secret_key)


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "riderlens-worker",
        "mediapipe": mp is not None,
        "opencv": cv2 is not None,
        "bike_detector_model": BIKE_MODEL_PATH.exists(),
        "captureBusy": CAPTURE_JOB_LOCK.locked(),
    }


# --- Dev analysis lab -------------------------------------------------------
# Local development dashboard. Disable with RIDERLENS_DEV_UI=0 (and keep it
# disabled on any deployed worker).

DEV_UI_ENABLED = os.getenv("RIDERLENS_DEV_UI", "1") != "0"
REPO_ROOT = FilePath(__file__).resolve().parents[2]
CLIPS_DIR = REPO_ROOT / "clips"
DEV_HTML_PATH = FilePath(__file__).resolve().parent / "dev.html"


def require_dev_ui() -> None:
    if not DEV_UI_ENABLED:
        raise HTTPException(status_code=404, detail="Not found.")


@app.get("/dev", response_class=HTMLResponse)
def dev_dashboard():
    require_dev_ui()
    if not DEV_HTML_PATH.exists():
        raise HTTPException(status_code=500, detail="dev.html is missing next to app/main.py.")
    return HTMLResponse(DEV_HTML_PATH.read_text(encoding="utf-8"))


@app.get("/dev/clips")
def dev_clips():
    require_dev_ui()
    manifest_path = CLIPS_DIR / "manifest.json"
    if not manifest_path.exists():
        return {"clips": []}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    clips = [
        {**entry, "available": (CLIPS_DIR / entry.get("file", "")).exists()}
        for entry in manifest.get("clips", [])
    ]
    return {"clips": clips}


class AIReviewRequest(BaseModel):
    metrics: list[Metric]
    series: list[dict] | None = None
    air_frames: list[dict] | None = None


@app.post("/dev/ai-review")
def dev_ai_review(request: AIReviewRequest):
    require_dev_ui()
    from .ai_review import AIReviewError, review_key_frames

    try:
        return review_key_frames(request.metrics, series=request.series, air_frames=request.air_frames)
    except AIReviewError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


class DevAnalyzeRequest(BaseModel):
    file: str
    trim_start_seconds: float = Field(default=0, ge=0)
    trim_end_seconds: float | None = Field(default=None, ge=0)


def resolve_clip_path(file: str) -> FilePath:
    clips_root = CLIPS_DIR.resolve()
    clip_path = (clips_root / file).resolve()
    if clips_root not in clip_path.parents:
        raise HTTPException(status_code=400, detail="Clip path must stay inside the clips directory.")
    if not clip_path.exists():
        raise HTTPException(status_code=404, detail=f"Clip not found: {file}")
    return clip_path


@app.post("/dev/analyze-clip", response_model=AnalyzeResponse)
def dev_analyze_clip(request: DevAnalyzeRequest):
    require_dev_ui()
    clip_path = resolve_clip_path(request.file)

    return analyze_regular_jump_file(
        session_id=f"dev-{re.sub(r'[^A-Za-z0-9_-]', '-', request.file)}",
        video_path=str(clip_path),
        trim_start_seconds=request.trim_start_seconds,
        trim_end_seconds=request.trim_end_seconds,
        crop_preset="full_side_view",
        include_frames=True,
    )


class DevPoseCompareRequest(BaseModel):
    file: str
    trim_start_seconds: float = Field(default=0, ge=0)
    trim_end_seconds: float | None = Field(default=None, ge=0)
    max_frames: int = Field(default=48, ge=4, le=120)


_rtmpose_engine = None


def _rtmpose():
    """Lazy: rtmlib is a dev-only dependency; production code paths never import it."""
    global _rtmpose_engine
    if _rtmpose_engine is None:
        from rtmlib import BodyWithFeet

        _rtmpose_engine = BodyWithFeet(mode="balanced", backend="onnxruntime", device="cpu")
    return _rtmpose_engine


@app.post("/dev/pose-compare")
def dev_pose_compare(request: DevPoseCompareRequest):
    """Same frames through both pose engines, returned as side-by-side JPEGs:
    MediaPipe heavy (what production runs) on the left, RTMPose (candidate
    replacement, halpe26 body+feet) on the right."""
    require_dev_ui()
    from rtmlib import draw_skeleton

    clip_path = resolve_clip_path(request.file)
    capture = cv2.VideoCapture(str(clip_path))
    if not capture.isOpened():
        raise HTTPException(status_code=422, detail="Could not open video.")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = total_frames / fps if fps else 0.0
    start = max(0.0, min(request.trim_start_seconds, max(duration - 0.1, 0.0)))
    end = duration if request.trim_end_seconds is None else min(request.trim_end_seconds, duration)
    end = max(end, start + 0.1)
    stride = max(1, math.ceil((end - start) * fps / request.max_frames))

    pose = mp.solutions.pose.Pose(
        static_image_mode=False,
        model_complexity=2,
        enable_segmentation=False,
        min_detection_confidence=0.3,
        min_tracking_confidence=0.3,
    )
    rtm = _rtmpose()
    drawer = mp.solutions.drawing_utils

    capture.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    frames: list[dict] = []
    mp_hits = rtm_hits = 0
    mp_seconds = rtm_seconds = 0.0
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        stamp = start + index / fps
        if stamp > end + 1e-6:
            break
        keep = index % stride == 0
        index += 1
        if not keep:
            continue

        scale = 640 / frame.shape[1]
        small = cv2.resize(frame, (640, int(frame.shape[0] * scale)))

        left = small.copy()
        tick = time.perf_counter()
        result = pose.process(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
        mp_seconds += time.perf_counter() - tick
        mp_found = result.pose_landmarks is not None
        if mp_found:
            mp_hits += 1
            drawer.draw_landmarks(left, result.pose_landmarks, mp.solutions.pose.POSE_CONNECTIONS)

        right = small.copy()
        tick = time.perf_counter()
        keypoints, scores = rtm(small)
        rtm_seconds += time.perf_counter() - tick
        rtm_found = len(scores) > 0 and float(np.median(scores[0])) > 0.3
        if rtm_found:
            rtm_hits += 1
            right = draw_skeleton(right, keypoints, scores, kpt_thr=0.3)

        encoded_ok, jpg = cv2.imencode(".jpg", np.hstack([left, right]), [cv2.IMWRITE_JPEG_QUALITY, 78])
        if encoded_ok:
            frames.append(
                {
                    "time": round(stamp, 2),
                    "image": base64.b64encode(jpg.tobytes()).decode("ascii"),
                    "mediapipe": mp_found,
                    "rtmpose": rtm_found,
                }
            )
    capture.release()
    pose.close()

    sampled = max(len(frames), 1)
    return {
        "frames": frames,
        "summary": {
            "sampled": len(frames),
            "mediapipe_hits": mp_hits,
            "rtmpose_hits": rtm_hits,
            "mediapipe_ms": round(mp_seconds / sampled * 1000),
            "rtmpose_ms": round(rtm_seconds / sampled * 1000),
        },
    }


# --- AI keyframe search (search first, measure second) ------------------------

EVENT_PHASE: dict[str, Phase] = {
    "approach": "approach",
    "compression": "compression",
    "takeoff": "takeoff",
    "peak_air": "air",
    "landing": "landing",
    "crash": "crash",
}


def extract_frames_at(video_path: str, times: list[float]) -> list[tuple[float, object]]:
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise HTTPException(status_code=422, detail="Could not open video.")
    frames: list[tuple[float, object]] = []
    try:
        for time_seconds in times:
            capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, time_seconds) * 1000.0)
            ok, frame = capture.read()
            if ok:
                frames.append((time_seconds, frame))
    finally:
        capture.release()
    return frames


def build_contact_sheet(
    video_path: str, trim_start_seconds: float, trim_end_seconds: float | None, count: int = 24, width: int = 480
) -> list[tuple[float, str]]:
    """Uniformly sampled, downscaled frames with timestamps — the input for AI keyframe search."""
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise HTTPException(status_code=422, detail="Could not open video.")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    capture.release()
    duration_seconds = frame_count / fps if frame_count > 0 else 0

    start = max(0.0, trim_start_seconds)
    end = trim_end_seconds if trim_end_seconds is not None else duration_seconds
    if duration_seconds > 0:
        end = min(max(end, start + 0.5), duration_seconds)
    window = max(end - start, 0.5)

    times = [start + window * (index + 0.5) / count for index in range(count)]
    sheet: list[tuple[float, str]] = []
    for time_seconds, frame in extract_frames_at(video_path, times):
        height, frame_width = frame.shape[:2]
        scale = width / frame_width
        small = cv2.resize(frame, (width, max(1, int(height * scale))))
        image = encode_frame_jpeg(small)
        if image:
            sheet.append((round(time_seconds, 2), image))
    return sheet


def build_metric_without_pose(session_id: str, phase: Phase, frame, time_seconds: float) -> Metric:
    """Metric for a frame where no trustworthy rider pose exists (e.g. post-crash): body angles
    zeroed with confidence 0, bike/floor geometry from the pose-independent detectors only."""
    height, width = frame.shape[:2]
    gray = cv2.medianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), 5)

    bike_box = detect_bike_box(frame)
    bike_box_norm: FrameRect | None = None
    tires_detected = False
    if bike_box is not None:
        box_x0, box_y0, box_x1, box_y1 = bike_box
        bike_box_norm = FrameRect(
            x=clamp(box_x0 / width, 0, 1),
            y=clamp(box_y0 / height, 0, 1),
            w=clamp((box_x1 - box_x0) / width, 0, 1),
            h=clamp((box_y1 - box_y0) / height, 0, 1),
        )
        wheel_radius = max(6.0, min(0.33 * (box_y1 - box_y0), 0.18 * (box_x1 - box_x0)))
        first_pred = (box_x0 + wheel_radius, box_y1 - wheel_radius)
        second_pred = (box_x1 - wheel_radius, box_y1 - wheel_radius)
        first_hit = confirm_wheel_circle(gray, first_pred, wheel_radius)
        second_hit = confirm_wheel_circle(gray, second_pred, wheel_radius)
        tires_detected = first_hit is not None and second_hit is not None
        first_center = first_hit if tires_detected else first_pred
        second_center = second_hit if tires_detected else second_pred
        tire_baseline = px_line(first_center, second_center, width, height)
        wheel_bottom_y = box_y1
        bike_x_range = (box_x0, box_x1)
    else:
        baseline_y = height * 0.85
        tire_baseline = px_line((width * 0.3, baseline_y), (width * 0.7, baseline_y), width, height)
        wheel_bottom_y = height * 0.9
        bike_x_range = (width * 0.2, width * 0.8)

    detected_floor = detect_floor_line(frame, wheel_bottom_y, bike_x_range) if bike_box is not None else None
    floor = detected_floor or estimated_floor_line(wheel_bottom_y, bike_x_range, width, height)

    center = FramePoint(x=0.5, y=0.5)
    degenerate = FrameLine(start=center, end=center)
    geometry = FrameGeometry(
        floor=floor,
        tireBaseline=tire_baseline,
        torso=degenerate,
        kneeUpper=degenerate,
        kneeLower=degenerate,
        landing=floor,
    )

    return Metric(
        phase=phase,
        frameTime=round(time_seconds, 2),
        torsoAngle=0,
        hipAngle=0,
        kneeAngle=0,
        elbowAngle=0,
        bikePitchAngle=round(px_line_angle(tire_baseline, width, height)),
        floorAngle=round(px_line_angle(floor, width, height)),
        tireBaselineAngle=round(px_line_angle(tire_baseline, width, height)),
        landingAlignmentAngle=round(px_line_angle(floor, width, height)),
        geometrySource="detected" if tires_detected and bike_box is not None else "estimated",
        geometry=geometry,
        bikeBox=bike_box_norm,
        confidence=0.0,
    )


# Full-body skeleton (both sides): shoulders, elbows, wrists, hips, knees, ankles.
SKELETON_CONNECTIONS = [
    (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
    (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (24, 26), (26, 28),
]
SKELETON_COLOR = (46, 255, 182)  # electric green, BGR
SKELETON_OUTLINE = (19, 22, 17)


def draw_skeleton(frame, landmarks, visibility_threshold: float = 0.5) -> None:
    """Burn the full-body pose skeleton into a frame (in place)."""
    height, width = frame.shape[:2]
    thickness = max(2, width // 320)

    def point(index: int):
        landmark = landmarks[index]
        if getattr(landmark, "visibility", 0) < visibility_threshold:
            return None
        return (int(clamp(float(landmark.x), 0, 1) * width), int(clamp(float(landmark.y), 0, 1) * height))

    for start_index, end_index in SKELETON_CONNECTIONS:
        start = point(start_index)
        end = point(end_index)
        if start is None or end is None:
            continue
        cv2.line(frame, start, end, SKELETON_OUTLINE, thickness + 2, cv2.LINE_AA)
        cv2.line(frame, start, end, SKELETON_COLOR, thickness, cv2.LINE_AA)
    for index in {index for connection in SKELETON_CONNECTIONS for index in connection}:
        joint = point(index)
        if joint is not None:
            cv2.circle(frame, joint, thickness + 1, SKELETON_OUTLINE, -1, cv2.LINE_AA)
            cv2.circle(frame, joint, thickness, SKELETON_COLOR, -1, cv2.LINE_AA)


# The share destination burned into every skeleton clip: watermark + end-card QR.
SHARE_URL = os.getenv("RIDERLENS_SHARE_URL", "https://riderlens.app")
ENDCARD_SECONDS = 2.8

WATERMARK_TEXT = "riderlens.app"
# Electric green + graphite outline, BGR (matches the skeleton palette).
WATERMARK_COLOR = (46, 255, 182)
WATERMARK_OUTLINE = (17, 20, 16)


def draw_watermark(frame) -> None:
    """Brand mark on the shareable overlay clip: bottom-right, outlined for
    legibility on any footage."""
    height, width = frame.shape[:2]
    scale = max(0.5, width / 1280 * 0.85)
    thickness = max(1, int(round(scale * 1.8)))
    (text_width, _), _ = cv2.getTextSize(WATERMARK_TEXT, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
    x = width - text_width - max(10, int(0.02 * width))
    y = height - max(12, int(0.03 * height))
    cv2.putText(frame, WATERMARK_TEXT, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, WATERMARK_OUTLINE, thickness + 2, cv2.LINE_AA)
    cv2.putText(frame, WATERMARK_TEXT, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, WATERMARK_COLOR, thickness, cv2.LINE_AA)


def build_endcard(width: int, height: int):
    """Closing frame for shared clips: graphite card, wordmark, QR to the
    share page. Whoever receives the clip can scan straight to the app."""
    import io

    import segno

    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    canvas[:] = (17, 20, 16)  # graphite, BGR

    # QR: dark modules on a white tile so any scanner reads it.
    qr_size = int(min(width, height) * 0.44)
    buffer = io.BytesIO()
    segno.make(SHARE_URL, error="m").save(buffer, kind="png", scale=12, border=2)
    qr_image = cv2.imdecode(np.frombuffer(buffer.getvalue(), np.uint8), cv2.IMREAD_COLOR)
    qr_image = cv2.resize(qr_image, (qr_size, qr_size), interpolation=cv2.INTER_NEAREST)
    qr_x = (width - qr_size) // 2
    qr_y = int(height * 0.28)
    canvas[qr_y : qr_y + qr_size, qr_x : qr_x + qr_size] = qr_image

    def centered_text(text: str, y: int, scale: float, color, thickness: int) -> None:
        (text_width, _), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
        cv2.putText(canvas, text, ((width - text_width) // 2, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thickness, cv2.LINE_AA)

    title_scale = max(0.9, width / 1280 * 1.6)
    centered_text("RIDERLENS", int(height * 0.18), title_scale, (46, 255, 182), max(2, int(title_scale * 2)))
    url_scale = max(0.6, width / 1280 * 0.9)
    centered_text(SHARE_URL.replace("https://", ""), int(height * 0.28) + qr_size + int(height * 0.09), url_scale, (240, 244, 236), max(1, int(url_scale * 2)))
    return canvas


class OverlayClipWriter:
    """Streams skeleton-burned frames to ffmpeg (libx264, phone-friendly);
    cv2 mp4v fallback when ffmpeg is missing. finalize() returns the mp4 bytes
    or None — overlay rendering must never fail the record."""

    def __init__(self, fps: float):
        self.fps = max(1.0, min(fps, 60.0))
        self.process = None
        self.writer = None
        self.output_path: str | None = None
        self.size: tuple[int, int] | None = None
        self.failed = False

    def add(self, frame) -> None:
        if self.failed:
            return
        try:
            if self.size is None:
                height, width = frame.shape[:2]
                width -= width % 2  # yuv420p needs even dimensions
                height -= height % 2
                self.size = (width, height)
                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                    self.output_path = tmp.name
                if shutil.which("ffmpeg"):
                    self.process = subprocess.Popen(
                        [
                            "ffmpeg", "-y",
                            "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", f"{width}x{height}", "-r", f"{self.fps:.3f}",
                            "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                            self.output_path,
                        ],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                else:
                    self.writer = cv2.VideoWriter(
                        self.output_path, cv2.VideoWriter_fourcc(*"mp4v"), self.fps, (width, height)
                    )
            cropped = frame[: self.size[1], : self.size[0]]
            if self.process is not None:
                self.process.stdin.write(cropped.tobytes())
            elif self.writer is not None:
                self.writer.write(cropped)
        except Exception:
            self.failed = True

    def finalize(self) -> bytes | None:
        try:
            if self.process is not None:
                self.process.stdin.close()
                if self.process.wait(timeout=120) != 0:
                    return None
            elif self.writer is not None:
                self.writer.release()
            else:
                return None
            if self.failed or not self.output_path or os.path.getsize(self.output_path) == 0:
                return None
            with open(self.output_path, "rb") as rendered:
                return rendered.read()
        except Exception:
            return None
        finally:
            if self.output_path:
                try:
                    os.unlink(self.output_path)
                except OSError:
                    pass


def filmstrip_encode_settings(
    frame_count: int,
    frame_width: int,
    frame_height: int,
    override_width: int | None = None,
) -> tuple[int, int]:
    """Keep every frame while bounding the response a phone must parse.

    The record also carries two base64 videos, so a filmstrip much above 12 MB
    can turn an ordinary 8-second clip into a large JSON document. These
    tiers retain source-frame density and spend resolution on shorter clips,
    where fewer images share the same mobile payload budget.
    """
    # The viewer paints these at up to ~1100 device px: widths below ~700
    # upscale visibly, and quality under ~75 reads as noise on foliage. The
    # frames are the product - spend the payload here first.
    if frame_count <= 96:
        base_width, quality = 960, 85
    elif frame_count <= 200:
        base_width, quality = 800, 80
    elif frame_count <= 300:
        base_width, quality = 704, 76
    else:
        base_width, quality = 640, 73

    if override_width is not None:
        return min(frame_width, max(1, override_width)), quality

    # At a given width, landscape thumbnails use far fewer pixels than portrait,
    # so they can spend a little more width without breaking the byte budget.
    target_width = round(base_width * 1.2) if frame_width >= frame_height else base_width
    return min(frame_width, target_width), quality


def measure_window(
    video_path: str,
    window_start: float,
    window_end: float,
    air_span: tuple[float, float],
    include_bike: bool = True,
    filmstrip_width: int | None = None,
    render_overlay: bool = False,
    include_air_frames: bool = True,
) -> tuple[list[dict], list[dict], list[dict], bytes | None]:
    """Dense per-frame measurement between the anchored window bounds.

    Pose runs at the source frame rate up to 60fps (capped at 480 frames) and the
    full-body skeleton is burned into every filmstrip thumbnail. The bike detector only runs when
    include_bike is set — the capture path skips it (pose-only records).
    Returns (series, air_frames, filmstrip, overlay_clip): air_frames are bounded,
    encoded thumbnails inside air_span for the AI review; filmstrip covers the whole
    window for the user; overlay_clip is the shareable skeleton-burned watermarked mp4
    (bytes) when render_overlay is set, else None.
    """
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise HTTPException(status_code=422, detail="Could not open video.")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    capture.release()

    span = max(window_end - window_start, 0.2)
    # Every frame is the point: analysis runs at source frame rate up to 60fps
    # (slow-mo footage keeps its detail). The sample ceiling only bounds
    # pathologically long windows — a 15s window at 30fps still gets every frame.
    step = 1.0 / min(fps, 60.0)
    count = int(span / step) + 1
    if count > 480:
        count = 480
        step = span / (count - 1)

    pose = mp.solutions.pose.Pose(
        static_image_mode=False,
        model_complexity=2,
        enable_segmentation=False,
        min_detection_confidence=0.3,
        min_tracking_confidence=0.3,
    )
    series: list[dict] = []
    air_frames: list[dict] = []
    filmstrip: list[dict] = []
    estimated_air_frames = max(1, int(max(0.0, air_span[1] - air_span[0]) / step) + 1)
    air_frame_stride = max(1, math.ceil(estimated_air_frames / 8))
    air_frame_cursor = 0
    # Frame-by-frame inspection needs every sampled frame in the strip. Density
    # is never thinned; dimensions and JPEG quality still fall as count rises.
    overlay = OverlayClipWriter(fps=1.0 / step) if render_overlay else None
    capture = cv2.VideoCapture(video_path)
    # Decode sequentially: one seek to the window start, then read straight
    # through, keeping every `stride`-th frame. Per-sample seeking re-decodes
    # from the previous keyframe each time — on 4K/HEVC phone footage that is
    # minutes of redundant work and starved the cloud worker into timeouts.
    capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, window_start) * 1000.0)
    stride = max(1, round(fps * step))
    try:
        frame_cursor = 0
        index = -1
        while index + 1 < count:
            grabbed = capture.grab()
            if not grabbed:
                break
            keep = frame_cursor % stride == 0
            frame_cursor += 1
            if not keep:
                continue
            ok, frame = capture.retrieve()
            if not ok:
                break
            index += 1
            time_seconds = window_start + index * step
            if time_seconds < 0:
                continue
            height, width = frame.shape[:2]
            entry: dict = {
                "t": round(time_seconds, 3),
                "kneeAngle": None,
                "torsoAngle": None,
                "hipHeight": None,
                "pitch": None,
                "confidence": 0.0,
            }

            result = pose.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            if result.pose_landmarks:
                landmarks = result.pose_landmarks.landmark
                side = get_visible_side(landmarks)
                shoulder = landmark_point(landmarks, 11 if side == "left" else 12)
                hip = landmark_point(landmarks, 23 if side == "left" else 24)
                knee = landmark_point(landmarks, 25 if side == "left" else 26)
                ankle = landmark_point(landmarks, 27 if side == "left" else 28)
                horizontal = FrameLine(start=FramePoint(x=0, y=hip.y), end=FramePoint(x=1, y=hip.y))
                entry["kneeAngle"] = round(px_joint_angle(hip, knee, ankle, width, height), 1)
                entry["torsoAngle"] = round(
                    px_angle_between_lines(FrameLine(start=hip, end=shoulder), horizontal, width, height), 1
                )
                entry["hipHeight"] = round(1.0 - hip.y, 3)
                entry["confidence"] = round(get_pose_confidence(landmarks, side), 2)

            if include_bike and index % 3 == 0:
                bike_box = detect_bike_box(frame)
                if bike_box is not None:
                    box_x0, box_y0, box_x1, box_y1 = bike_box
                    wheel_radius = max(6.0, min(0.33 * (box_y1 - box_y0), 0.18 * (box_x1 - box_x0)))
                    gray = cv2.medianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), 5)
                    first_hit = confirm_wheel_circle(gray, (box_x0 + wheel_radius, box_y1 - wheel_radius), wheel_radius)
                    second_hit = confirm_wheel_circle(gray, (box_x1 - wheel_radius, box_y1 - wheel_radius), wheel_radius)
                    if first_hit is not None and second_hit is not None:
                        entry["pitch"] = round(
                            px_line_angle(px_line(first_hit, second_hit, width, height), width, height), 1
                        )

            if overlay is not None:
                # Shareable overlay clip: every sampled frame, skeleton + watermark.
                share_width = min(width, 1280)
                share = (
                    cv2.resize(frame, (share_width, max(1, int(height * share_width / width))))
                    if share_width < width
                    else frame.copy()
                )
                if result.pose_landmarks:
                    draw_skeleton(share, result.pose_landmarks.landmark)
                draw_watermark(share)
                overlay.add(share)

            if include_air_frames and air_span[0] <= time_seconds <= air_span[1]:
                # Encode at most eight reference frames immediately. Keeping all
                # full-resolution candidates alive until the end made a 1080p,
                # six-second window consume multiple gigabytes.
                if air_frame_cursor % air_frame_stride == 0 and len(air_frames) < 8:
                    air_width = min(width, 480)
                    air_small = (
                        cv2.resize(frame, (air_width, max(1, int(height * air_width / width))))
                        if air_width < width
                        else frame.copy()
                    )
                    air_image = encode_frame_jpeg(air_small)
                    if air_image:
                        air_frames.append({"t": round(time_seconds, 2), "image": air_image})
                air_frame_cursor += 1
            target_width, strip_quality = filmstrip_encode_settings(
                count,
                width,
                height,
                filmstrip_width,
            )
            small = (
                cv2.resize(
                    frame,
                    (target_width, max(1, int(height * target_width / width))),
                    interpolation=cv2.INTER_AREA,
                )
                if target_width < width
                else frame.copy()
            )
            if result.pose_landmarks:
                draw_skeleton(small, result.pose_landmarks.landmark)
            image = encode_frame_jpeg(small, quality=strip_quality)
            if image:
                filmstrip.append({"t": round(time_seconds, 2), "image": image})
            series.append(entry)
    finally:
        pose.close()
        capture.release()

    overlay_clip = None
    if overlay is not None:
        # Close the share clip with the QR end-card before encoding finishes.
        if overlay.size is not None and not overlay.failed:
            endcard = build_endcard(*overlay.size)
            endcard_frames = max(1, int(ENDCARD_SECONDS / step))
            for _ in range(endcard_frames):
                overlay.add(endcard)
        overlay_clip = overlay.finalize()
    return series, air_frames, filmstrip, overlay_clip


def window_from_events(events: list[dict]) -> dict | None:
    """Crop window from AI events: takeoff-0.7s to landing/crash+0.7s (plus anchors)."""
    event_times = {
        event["name"]: float(event["time_seconds"]) for event in events if event.get("name") in EVENT_PHASE
    }
    if not event_times:
        return None
    start_anchor = event_times.get("takeoff", min(event_times.values()))
    end_anchor = event_times.get("landing") or event_times.get("crash") or max(event_times.values())
    end_anchor = max(end_anchor, start_anchor)
    return {
        "start": round(max(0.0, start_anchor - 0.7), 2),
        "end": round(end_anchor + 0.7, 2),
        "anchorStart": start_anchor,
        "anchorEnd": end_anchor,
    }


def metrics_at_times(
    video_path: str,
    labeled_times: list[tuple[Phase, float]],
    trim_start_seconds: float,
    trim_end_seconds: float | None,
    session_id: str,
) -> list[Metric]:
    """Measured key-frame metrics at specific times: nearest tracked pose frame when one
    exists within 0.4s, otherwise a poseless metric from the exact frame."""
    pose_frames, fps, _duration = extract_pose_frames(video_path, trim_start_seconds, trim_end_seconds)
    metrics: list[Metric] = []
    for phase, target in labeled_times:
        nearest = min(pose_frames, key=lambda pose_frame: abs(pose_frame.time_seconds - target)) if pose_frames else None
        if nearest is not None and abs(nearest.time_seconds - target) <= 0.4:
            metric = build_metric(session_id, phase, nearest, fps)
            metric.frameImage = encode_frame_jpeg(nearest.frame)
        else:
            frames = extract_frames_at(video_path, [target])
            if not frames:
                continue
            _, frame = frames[0]
            metric = build_metric_without_pose(session_id, phase, frame, target)
            metric.frameImage = encode_frame_jpeg(frame)
        metrics.append(metric)
    return metrics


class DevKeyframesRequest(BaseModel):
    file: str
    trim_start_seconds: float = Field(default=0, ge=0)
    trim_end_seconds: float | None = Field(default=None, ge=0)


@app.post("/dev/find-key-frames")
def dev_find_key_frames(request: DevKeyframesRequest):
    require_dev_ui()
    clip_path = resolve_clip_path(request.file)
    return run_keyframe_search(str(clip_path), request.trim_start_seconds, request.trim_end_seconds, request.file)


@app.post("/dev/find-key-frames-upload")
def dev_find_key_frames_upload(
    video: UploadFile = File(...),
    trim_start_seconds: float = Form(0),
    trim_end_seconds: float | None = Form(None),
):
    require_dev_ui()
    if not video.content_type or not video.content_type.startswith("video/"):
        raise HTTPException(status_code=415, detail="Upload a video file.")

    suffix = os.path.splitext(video.filename or "clip.mp4")[1] or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        shutil.copyfileobj(video.file, temp_file)
        temp_path = temp_file.name

    try:
        return run_keyframe_search(temp_path, trim_start_seconds, trim_end_seconds, video.filename or "upload")
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def run_keyframe_search(video_path: str, trim_start_seconds: float, trim_end_seconds: float | None, label: str):
    if cv2 is None or mp is None or np is None:
        raise HTTPException(status_code=503, detail="Install worker dependencies: mediapipe, opencv-python-headless, numpy.")

    from .ai_review import AIReviewError, find_key_frames_ai

    sheet = build_contact_sheet(video_path, trim_start_seconds, trim_end_seconds)
    if not sheet:
        raise HTTPException(status_code=422, detail="Could not extract frames from this clip.")

    try:
        search = find_key_frames_ai(sheet)
    except AIReviewError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))

    labeled_times = [
        (EVENT_PHASE[event["name"]], float(event["time_seconds"]))
        for event in search.get("events", [])
        if event.get("name") in EVENT_PHASE
    ]
    metrics = metrics_at_times(
        video_path, labeled_times, trim_start_seconds, trim_end_seconds, f"kf-{re.sub(r'[^A-Za-z0-9_-]', '-', label)}"
    )

    series: list[dict] = []
    air_frames: list[dict] = []
    filmstrip: list[dict] = []
    window = window_from_events(search.get("events", []))
    if window is not None:
        series, air_frames, filmstrip, _overlay = measure_window(
            video_path,
            window["start"],
            window["end"],
            (window["anchorStart"], window["anchorEnd"]),
            )

    return {
        "eventType": search["event_type"],
        "summary": search["summary"],
        "model": search.get("model"),
        "events": search["events"],
        "metrics": metrics,
        "window": window,
        "series": series,
        "airFrames": air_frames,
        "filmstrip": filmstrip,
    }


MANIFEST_PATH = CLIPS_DIR / "manifest.json"
LABELS_PATH = CLIPS_DIR / "labels.json"


class SaveGroundTruthRequest(BaseModel):
    file: str
    event_type: str
    events: list[dict]
    model: str | None = None


@app.post("/dev/save-ground-truth")
def dev_save_ground_truth(request: SaveGroundTruthRequest):
    require_dev_ui()
    if not MANIFEST_PATH.exists():
        raise HTTPException(status_code=404, detail="clips/manifest.json not found.")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    entry = next((clip for clip in manifest.get("clips", []) if clip.get("file") == request.file), None)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Clip not in manifest: {request.file}")

    entry["groundTruth"] = {
        "source": "ai",
        "model": request.model,
        "eventType": request.event_type,
        "events": request.events,
        "savedAt": datetime.now(timezone.utc).isoformat(),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"ok": True}


class SaveLabelsRequest(BaseModel):
    file: str
    frame_time: float
    phase: str
    geometry: dict


@app.post("/dev/save-labels")
def dev_save_labels(request: SaveLabelsRequest):
    require_dev_ui()
    resolve_clip_path(request.file)

    labels = {"labels": []}
    if LABELS_PATH.exists():
        labels = json.loads(LABELS_PATH.read_text(encoding="utf-8"))
    entries = labels.setdefault("labels", [])
    key = (request.file, round(request.frame_time, 2))
    entries[:] = [entry for entry in entries if (entry.get("file"), round(entry.get("frameTime", -1), 2)) != key]
    entries.append(
        {
            "file": request.file,
            "frameTime": round(request.frame_time, 2),
            "phase": request.phase,
            "geometry": request.geometry,
            "savedAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    entries.sort(key=lambda entry: (entry["file"], entry["frameTime"]))
    LABELS_PATH.write_text(json.dumps(labels, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "count": len(entries)}


@app.post("/analysis/regular-jump", response_model=AnalyzeResponse, dependencies=PROTECTED)
def analyze_regular_jump_upload(
    video: UploadFile = File(...),
    session_id: str = Form(...),
    trim_start_seconds: float = Form(0),
    trim_end_seconds: float | None = Form(None),
    crop_preset: CropPreset = Form("full_side_view"),
    include_frames: bool = Form(False),
):
    if not video.content_type or not video.content_type.startswith("video/"):
        raise HTTPException(status_code=415, detail="Upload a video file.")

    suffix = os.path.splitext(video.filename or "jump.mp4")[1] or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        shutil.copyfileobj(video.file, temp_file)
        temp_path = temp_file.name

    try:
        return analyze_regular_jump_file(
            session_id=session_id,
            video_path=temp_path,
            trim_start_seconds=trim_start_seconds,
            trim_end_seconds=trim_end_seconds,
            crop_preset=crop_preset,
            include_frames=include_frames,
        )
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


@app.post("/jobs/{job_id}/analyze", response_model=AnalyzeResponse, dependencies=PROTECTED)
def analyze(job_id: str, request: AnalyzeRequest):
    if request.skill_type != "regular_jump":
        raise HTTPException(status_code=422, detail="Only regular_jump is implemented in the MVP worker.")
    if not os.path.exists(request.raw_video_path):
        raise HTTPException(
            status_code=422,
            detail="raw_video_path must be a local file for the MVP worker. Use /analysis/regular-jump for mobile uploads.",
        )

    supabase = get_supabase()
    if supabase:
        started_at = datetime.now(timezone.utc).isoformat()
        supabase.table("analysis_jobs").update(
            {
                "status": "processing",
                "progress": 20,
                "started_at": started_at,
                "error_code": None,
                "error_message": None,
            }
        ).eq("id", job_id).eq("session_id", request.session_id).execute()
        supabase.table("analysis_sessions").update({"status": "processing"}).eq(
            "id", request.session_id
        ).execute()

    try:
        response = analyze_regular_jump_file(
            session_id=request.session_id,
            video_path=request.raw_video_path,
            trim_start_seconds=request.trim_start_seconds,
            trim_end_seconds=request.trim_end_seconds,
            crop_preset=request.crop_preset,
        )
    except Exception as error:
        if supabase:
            finished_at = datetime.now(timezone.utc).isoformat()
            supabase.table("analysis_jobs").update(
                {
                    "status": "failed",
                    "progress": 0,
                    "error_code": "analysis_failed",
                    "error_message": str(error)[:1000],
                    "finished_at": finished_at,
                }
            ).eq("id", job_id).eq("session_id", request.session_id).execute()
            supabase.table("analysis_sessions").update(
                {
                    "status": "failed",
                    "error_code": "analysis_failed",
                    "error_message": str(error)[:1000],
                }
            ).eq("id", request.session_id).execute()
        raise

    if supabase:
        finished_at = datetime.now(timezone.utc).isoformat()
        supabase.table("analysis_jobs").update(
            {"status": "completed", "progress": 100, "finished_at": finished_at}
        ).eq("id", job_id).eq("session_id", request.session_id).execute()
        supabase.table("analysis_sessions").update(
            {"status": "completed", "completed_at": finished_at}
        ).eq("id", request.session_id).execute()

    return response


def analyze_regular_jump_file(
    session_id: str,
    video_path: str,
    trim_start_seconds: float,
    trim_end_seconds: float | None,
    crop_preset: CropPreset,
    include_frames: bool = False,
) -> AnalyzeResponse:
    if cv2 is None or mp is None or np is None:
        raise HTTPException(status_code=503, detail="Install worker dependencies: mediapipe, opencv-python-headless, numpy.")

    if crop_preset != "full_side_view":
        # MVP behavior: keep the uploaded pixels intact. The app still records the preset for later.
        pass

    pose_frames, fps, duration_seconds = extract_pose_frames(video_path, trim_start_seconds, trim_end_seconds)
    if not pose_frames:
        raise HTTPException(
            status_code=422,
            detail="MediaPipe could not detect a rider pose in this clip. Use a bright side-view clip with the rider fully visible.",
        )

    end_seconds = trim_end_seconds if trim_end_seconds is not None else duration_seconds
    selected = select_phase_frames(pose_frames, trim_start_seconds, end_seconds)
    metrics = []
    for phase, pose_frame in selected:
        metric = build_metric(session_id, phase, pose_frame, fps)
        if include_frames:
            metric.frameImage = encode_frame_jpeg(pose_frame.frame)
        metrics.append(metric)
    response = AnalyzeResponse(status="completed", metrics=metrics, report=build_report(metrics))
    save_debug_snapshot(
        session_id,
        {
            "videoPath": video_path,
            "trimStartSeconds": trim_start_seconds,
            "trimEndSeconds": trim_end_seconds,
            "cropPreset": crop_preset,
            "fps": fps,
            "durationSeconds": duration_seconds,
            "poseFrameCount": len(pose_frames),
        },
        response,
    )
    return response


def save_debug_snapshot(session_id: str, request_info: dict, response: AnalyzeResponse) -> None:
    """Archive request metadata + full response JSON for debugging real clips.

    Enabled only when RIDERLENS_SNAPSHOT_DIR is set. Snapshots must never fail an analysis.
    """
    snapshot_dir = os.getenv("RIDERLENS_SNAPSHOT_DIR")
    if not snapshot_dir:
        return
    try:
        os.makedirs(snapshot_dir, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        safe_session = re.sub(r"[^A-Za-z0-9_-]", "_", session_id)[:64]
        path = os.path.join(snapshot_dir, f"{stamp}-{safe_session}.json")
        payload = {
            "savedAt": datetime.now(timezone.utc).isoformat(),
            "request": request_info,
            # frameImage is dev-UI-only base64 pixel data; keep snapshots small and diffable.
            "response": response.model_dump(exclude={"metrics": {"__all__": {"frameImage"}}}),
        }
        with open(path, "w", encoding="utf-8") as snapshot_file:
            json.dump(payload, snapshot_file, indent=2)
    except OSError:
        pass


def extract_pose_frames(video_path: str, trim_start_seconds: float, trim_end_seconds: float | None) -> tuple[list[PoseFrame], float, float]:
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise HTTPException(status_code=422, detail="Could not open uploaded video.")

    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    duration_seconds = frame_count / fps if frame_count > 0 else 0
    start_seconds = max(0, trim_start_seconds)
    end_seconds = trim_end_seconds if trim_end_seconds is not None else duration_seconds
    if duration_seconds > 0:
        end_seconds = min(max(end_seconds, start_seconds + 0.5), duration_seconds)

    start_frame = int(start_seconds * fps)
    end_frame = int(end_seconds * fps) if end_seconds else int(frame_count)
    sample_step = max(1, int(fps / 8))
    max_samples = 120
    pose_frames: list[PoseFrame] = []

    pose = mp.solutions.pose.Pose(
        static_image_mode=False,
        model_complexity=2,
        enable_segmentation=False,
        min_detection_confidence=0.45,
        min_tracking_confidence=0.45,
    )

    try:
        frame_index = start_frame
        capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        samples = 0
        while frame_index <= end_frame and samples < max_samples:
            ok, frame = capture.read()
            if not ok:
                break

            if (frame_index - start_frame) % sample_step == 0:
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = pose.process(rgb_frame)
                if result.pose_landmarks:
                    landmarks = result.pose_landmarks.landmark
                    side = get_visible_side(landmarks)
                    confidence = get_pose_confidence(landmarks, side)
                    if confidence >= 0.35:
                        pose_frames.append(PoseFrame(frame_index / fps, frame.copy(), landmarks, side, confidence))
                    samples += 1

            frame_index += 1
    finally:
        pose.close()
        capture.release()

    return pose_frames, fps, duration_seconds


def select_phase_frames(pose_frames: list[PoseFrame], start_seconds: float, end_seconds: float) -> list[tuple[Phase, PoseFrame]]:
    phases: list[tuple[Phase, float]] = [
        ("approach", 0.12),
        ("compression", 0.32),
        ("takeoff", 0.48),
        ("air", 0.66),
        ("landing", 0.86),
    ]
    window = max(0.5, end_seconds - start_seconds)
    selected: list[tuple[Phase, PoseFrame]] = []
    for phase, ratio in phases:
        target = start_seconds + window * ratio
        selected.append((phase, min(pose_frames, key=lambda pose_frame: abs(pose_frame.time_seconds - target))))
    return selected


def build_metric(session_id: str, phase: Phase, pose_frame: PoseFrame, fps: float) -> Metric:
    landmarks = pose_frame.landmarks
    side = pose_frame.side
    shoulder = landmark_point(landmarks, 11 if side == "left" else 12)
    elbow = landmark_point(landmarks, 13 if side == "left" else 14)
    wrist = landmark_point(landmarks, 15 if side == "left" else 16)
    hip = landmark_point(landmarks, 23 if side == "left" else 24)
    knee = landmark_point(landmarks, 25 if side == "left" else 26)
    ankle = landmark_point(landmarks, 27 if side == "left" else 28)
    foot = landmark_point(landmarks, 31 if side == "left" else 32)

    height, width = pose_frame.frame.shape[:2]

    def to_px(point: FramePoint) -> tuple[float, float]:
        return (point.x * width, point.y * height)

    trustworthy_pose = pose_frame.confidence >= 0.8
    gray = cv2.medianBlur(cv2.cvtColor(pose_frame.frame, cv2.COLOR_BGR2GRAY), 5)

    bike_box = detect_bike_box(pose_frame.frame)
    bike_box_norm: FrameRect | None = None
    if bike_box is not None:
        box_x0, box_y0, box_x1, box_y1 = bike_box
        bike_box_norm = FrameRect(
            x=clamp(box_x0 / width, 0, 1),
            y=clamp(box_y0 / height, 0, 1),
            w=clamp((box_x1 - box_x0) / width, 0, 1),
            h=clamp((box_y1 - box_y0) / height, 0, 1),
        )
        # Side-on, the wheels sit in the lower corners of the bike box.
        wheel_radius = max(6.0, min(0.33 * (box_y1 - box_y0), 0.18 * (box_x1 - box_x0)))
        first_pred = (box_x0 + wheel_radius, box_y1 - wheel_radius)
        second_pred = (box_x1 - wheel_radius, box_y1 - wheel_radius)
        # The box is pixel-grounded, so circle refinement is safe regardless of pose quality.
        first_hit = confirm_wheel_circle(gray, first_pred, wheel_radius)
        second_hit = confirm_wheel_circle(gray, second_pred, wheel_radius)
        tires_detected = first_hit is not None and second_hit is not None
        # Mixing one refined wheel with one predicted wheel tilts the baseline artificially;
        # only trust the refinements as a pair.
        first_center = first_hit if tires_detected else first_pred
        second_center = second_hit if tires_detected else second_pred
        wheel_bottom_y = box_y1
        bike_x_range = (box_x0, box_x1)
        floor_anchor_trusted = True
    else:
        # No bike box: fall back to pose-anchored estimation. With a low-confidence pose the
        # anchors are unreliable and "confirmations" are usually background texture.
        rear_pred, front_pred, wheel_radius = estimate_wheel_geometry(
            shoulder=to_px(shoulder), hip=to_px(hip), ankle=to_px(ankle), foot=to_px(foot), wrist=to_px(wrist)
        )
        first_hit = confirm_wheel_circle(gray, rear_pred, wheel_radius) if trustworthy_pose else None
        second_hit = confirm_wheel_circle(gray, front_pred, wheel_radius) if trustworthy_pose else None
        tires_detected = first_hit is not None and second_hit is not None
        first_center = first_hit if tires_detected else rear_pred
        second_center = second_hit if tires_detected else front_pred
        wheel_bottom_y = max(first_center[1], second_center[1]) + wheel_radius
        bike_x_range = (min(first_center[0], second_center[0]) - wheel_radius, max(first_center[0], second_center[0]) + wheel_radius)
        floor_anchor_trusted = trustworthy_pose

    tire_baseline = px_line(first_center, second_center, width, height)
    detected_floor = detect_floor_line(pose_frame.frame, wheel_bottom_y, bike_x_range) if floor_anchor_trusted else None
    floor = detected_floor or estimated_floor_line(wheel_bottom_y, bike_x_range, width, height)
    landing = floor
    # "detected" needs pair-confirmed wheels plus a second pixel-grounded signal: the bike box
    # (whose bottom edge anchors the floor at tire contact) or an actual floor edge.
    geometry_source: GeometrySource = (
        "detected" if tires_detected and (bike_box is not None or detected_floor is not None) else "estimated"
    )
    geometry = FrameGeometry(
        floor=floor,
        tireBaseline=tire_baseline,
        torso=FrameLine(start=hip, end=shoulder),
        kneeUpper=FrameLine(start=hip, end=knee),
        kneeLower=FrameLine(start=knee, end=ankle),
        landing=landing,
    )

    floor_angle = px_line_angle(floor, width, height)
    tire_angle = px_line_angle(tire_baseline, width, height)
    landing_angle = px_line_angle(landing, width, height)
    torso_angle = px_angle_between_lines(FrameLine(start=hip, end=shoulder), floor, width, height)
    hip_angle = px_joint_angle(shoulder, hip, knee, width, height)
    knee_angle = px_joint_angle(hip, knee, ankle, width, height)
    elbow_angle = px_joint_angle(shoulder, elbow, wrist, width, height)
    confidence = clamp(pose_frame.confidence, 0, 1)

    return Metric(
        phase=phase,
        frameTime=round(pose_frame.time_seconds, 2),
        torsoAngle=round(torso_angle),
        hipAngle=round(hip_angle),
        kneeAngle=round(knee_angle),
        elbowAngle=round(elbow_angle),
        bikePitchAngle=round(tire_angle),
        floorAngle=round(floor_angle),
        tireBaselineAngle=round(tire_angle),
        landingAlignmentAngle=round(landing_angle),
        geometrySource=geometry_source,
        geometry=geometry,
        bikeBox=bike_box_norm,
        confidence=round(confidence, 2),
    )


def build_report(metrics: list[Metric]) -> Report:
    takeoff = next((metric for metric in metrics if metric.phase == "takeoff"), metrics[0])
    landing = next((metric for metric in metrics if metric.phase == "landing"), metrics[-1])
    min_confidence = min(metric.confidence for metric in metrics)
    improvements = [
        "Use the MediaPipe body landmarks as the first read, then manually refine tire centers and floor line when needed.",
        "Compare takeoff torso and knee bend against the good-jump references before changing technique.",
    ]

    if takeoff.kneeAngle > 150:
        improvements.append("Takeoff looks stiff; add more compression before extending from the lip.")
    if landing.kneeAngle > 150:
        improvements.append("Landing legs look locked; prepare to absorb with more knee bend.")
    if takeoff.torsoAngle < 35:
        improvements.append("Torso is very low at takeoff; keep pressure balanced through feet instead of diving toward the bars.")

    return Report(
        summary=(
            "MediaPipe detected the rider body across the jump. Treat this MVP as body-position feedback; refine bike and floor lines manually when they look off."
            if min_confidence >= 0.55
            else "MediaPipe found the rider, but confidence is limited. Use this as a rough read and calibrate the key frame manually."
        ),
        strengths=[
            "The rider is visible enough for MediaPipe body-landmark analysis.",
            "The clip now has measured takeoff, air, and landing body angles.",
        ],
        improvements=improvements,
        drills=[
            "Film the same jump again from a clean side angle with both wheels visible.",
            "Do slow pump-throughs and compare compression knee angle against the reference library.",
            "Repeat on a small table and look for smoother extension from compression to takeoff.",
        ],
    )


def encode_frame_jpeg(frame, quality: int = 80) -> str | None:
    ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        return None
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def get_visible_side(landmarks) -> Literal["left", "right"]:
    left_indices = [11, 13, 23, 25, 27, 31]
    right_indices = [12, 14, 24, 26, 28, 32]
    left_score = sum(getattr(landmarks[index], "visibility", 0) for index in left_indices)
    right_score = sum(getattr(landmarks[index], "visibility", 0) for index in right_indices)
    return "left" if left_score >= right_score else "right"


def get_pose_confidence(landmarks, side: Literal["left", "right"]) -> float:
    indices = [11, 13, 15, 23, 25, 27, 31] if side == "left" else [12, 14, 16, 24, 26, 28, 32]
    return sum(getattr(landmarks[index], "visibility", 0) for index in indices) / len(indices)


def landmark_point(landmarks, index: int) -> FramePoint:
    landmark = landmarks[index]
    return FramePoint(x=clamp(float(landmark.x), 0, 1), y=clamp(float(landmark.y), 0, 1))


# --- Bike object detection ---------------------------------------------------
# MediaPipe Object Detector (EfficientDet-Lite2, COCO) finds the bicycle as a
# whole object, which survives the motion blur that defeats edge-based wheel
# detection. The model is downloaded once into worker/models/.

BIKE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float32/latest/efficientdet_lite2.tflite"
BIKE_MODEL_PATH = FilePath(__file__).resolve().parents[1] / "models" / "efficientdet_lite2.tflite"
BIKE_SCORE_THRESHOLD = 0.35

_bike_detector = None  # None = not initialized, False = unavailable


def get_bike_detector():
    global _bike_detector
    if _bike_detector is not None:
        return _bike_detector or None
    try:
        if not BIKE_MODEL_PATH.exists():
            BIKE_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
            print(f"[riderlens] downloading bike detection model to {BIKE_MODEL_PATH} ...")
            import ssl

            import certifi

            context = ssl.create_default_context(cafile=certifi.where())
            with urllib.request.urlopen(BIKE_MODEL_URL, context=context) as response, open(BIKE_MODEL_PATH, "wb") as out:
                shutil.copyfileobj(response, out)
            print("[riderlens] bike detection model ready")

        from mediapipe.tasks import python as tasks_python
        from mediapipe.tasks.python import vision as tasks_vision

        _bike_detector = tasks_vision.ObjectDetector.create_from_options(
            tasks_vision.ObjectDetectorOptions(
                base_options=tasks_python.BaseOptions(model_asset_path=str(BIKE_MODEL_PATH)),
                running_mode=tasks_vision.RunningMode.IMAGE,
                category_allowlist=["bicycle"],
                score_threshold=BIKE_SCORE_THRESHOLD,
                max_results=3,
            )
        )
    except Exception as error:  # detector is an enhancement; analysis must keep working without it
        print(f"[riderlens] bike detector unavailable, falling back to pose-only geometry: {error}")
        _bike_detector = False
    return _bike_detector or None


def detect_bike_box(frame) -> tuple[float, float, float, float] | None:
    """Return the highest-score bicycle box as pixel (x0, y0, x1, y1), or None."""
    detector = get_bike_detector()
    if detector is None:
        return None
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    best = None
    best_score = 0.0
    for detection in result.detections:
        score = detection.categories[0].score if detection.categories else 0.0
        if score > best_score:
            box = detection.bounding_box
            best = (
                float(box.origin_x),
                float(box.origin_y),
                float(box.origin_x + box.width),
                float(box.origin_y + box.height),
            )
            best_score = score
    return best


# --- Bike geometry heuristics -----------------------------------------------
# MediaPipe only sees the rider, but the bike is attached to the rider: the feet
# sit near the bottom bracket, which shares a height line with the wheel hubs.
# Wheel positions are therefore predicted from body scale and facing direction,
# then confirmed (or not) with a circle search restricted to those predictions.
# All heuristic work happens in pixel space; normalized lines are built at the end.


def estimate_wheel_geometry(
    shoulder: tuple[float, float],
    hip: tuple[float, float],
    ankle: tuple[float, float],
    foot: tuple[float, float],
    wrist: tuple[float, float],
) -> tuple[tuple[float, float], tuple[float, float], float]:
    """Predict (rear_center, front_center, wheel_radius) in pixels from rider pose."""
    leg = math.hypot(hip[0] - ankle[0], hip[1] - ankle[1])
    leg = max(leg, 8.0)
    facing = 1.0 if wrist[0] >= shoulder[0] else -1.0

    wheel_radius = 0.42 * leg
    hub_y = foot[1] - 0.06 * leg
    rear_center = (foot[0] - facing * 0.72 * leg, hub_y)
    front_center = (foot[0] + facing * 0.98 * leg, hub_y)
    return rear_center, front_center, wheel_radius


def confirm_wheel_circle(gray, predicted_center: tuple[float, float], radius: float) -> tuple[float, float] | None:
    """Look for a wheel-sized circle near the predicted center. Returns the refined center or None."""
    height, width = gray.shape[:2]
    center_x, center_y = predicted_center
    margin = int(1.5 * radius)
    x0, x1 = int(max(0, center_x - margin)), int(min(width, center_x + margin))
    y0, y1 = int(max(0, center_y - margin)), int(min(height, center_y + margin))
    if x1 - x0 < radius * 1.5 or y1 - y0 < radius * 1.5:
        return None

    roi = gray[y0:y1, x0:x1]
    circles = cv2.HoughCircles(
        roi,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(12, radius),
        param1=90,
        param2=27,
        minRadius=max(6, int(0.62 * radius)),
        maxRadius=int(1.3 * radius),
    )
    if circles is None:
        return None

    best = None
    best_distance = float("inf")
    for x, y, _r in np.round(circles[0, :]).astype("int"):
        distance = math.hypot(x + x0 - center_x, y + y0 - center_y)
        if distance < best_distance:
            best_distance = distance
            best = (float(x + x0), float(y + y0))
    # A confirmation far from the pose-anchored prediction is more likely foliage than a wheel.
    if best is None or best_distance > 0.5 * radius:
        return None
    return best


def detect_floor_line(frame, wheel_bottom_y: float, bike_x_range: tuple[float, float]) -> FrameLine | None:
    """Find a ground edge in the band just under the wheels, near the bike."""
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 60, 140)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=60, minLineLength=int(width * 0.16), maxLineGap=24)
    if lines is None:
        return None

    band_top = wheel_bottom_y - height * 0.06
    band_bottom = wheel_bottom_y + height * 0.20
    x_min = bike_x_range[0] - width * 0.12
    x_max = bike_x_range[1] + width * 0.12

    best = None
    best_score = -float("inf")
    for line in lines[:, 0]:
        x1, y1, x2, y2 = [int(value) for value in line]
        angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
        midpoint_y = (y1 + y2) / 2
        midpoint_x = (x1 + x2) / 2
        length = math.hypot(x2 - x1, y2 - y1)
        if abs(angle) > 35:
            continue
        if not (band_top <= midpoint_y <= band_bottom):
            continue
        if not (x_min <= midpoint_x <= x_max):
            continue
        score = length - 1.5 * abs(midpoint_y - wheel_bottom_y)
        if score > best_score:
            best_score = score
            best = (x1, y1, x2, y2)

    if best is None:
        return None

    x1, y1, x2, y2 = best
    return px_line((x1, y1), (x2, y2), width, height)


def estimated_floor_line(wheel_bottom_y: float, bike_x_range: tuple[float, float], width: int, height: int) -> FrameLine:
    """Fallback: a horizontal line tangent to the bottom of the estimated wheels."""
    span = max(bike_x_range[1] - bike_x_range[0], width * 0.2)
    x0 = bike_x_range[0] - span * 0.25
    x1 = bike_x_range[1] + span * 0.25
    return px_line((x0, wheel_bottom_y), (x1, wheel_bottom_y), width, height)


def px_line(first: tuple[float, float], second: tuple[float, float], width: int, height: int) -> FrameLine:
    left, right = sorted([first, second], key=lambda point: point[0])
    return FrameLine(
        start=FramePoint(x=clamp(left[0] / width, 0, 1), y=clamp(left[1] / height, 0, 1)),
        end=FramePoint(x=clamp(right[0] / width, 0, 1), y=clamp(right[1] / height, 0, 1)),
    )


# Pixel-space angle math. Normalized coordinates distort angles by the frame's
# aspect ratio (a 45-degree visual line reads ~29 degrees on 16:9), so all angle
# *numbers* are computed in pixel space; normalized lines remain for overlays.


def px_line_angle(line: FrameLine, width: int, height: int) -> float:
    return normalize_angle(
        math.degrees(math.atan2((line.end.y - line.start.y) * height, (line.end.x - line.start.x) * width))
    )


def px_angle_between_lines(first: FrameLine, second: FrameLine, width: int, height: int) -> float:
    diff = abs(normalize_angle(px_line_angle(first, width, height) - px_line_angle(second, width, height)))
    return min(diff, 180 - diff)


def px_joint_angle(first: FramePoint, joint: FramePoint, second: FramePoint, width: int, height: int) -> float:
    first_vector = ((first.x - joint.x) * width, (first.y - joint.y) * height)
    second_vector = ((second.x - joint.x) * width, (second.y - joint.y) * height)
    first_magnitude = math.hypot(*first_vector)
    second_magnitude = math.hypot(*second_vector)
    if first_magnitude == 0 or second_magnitude == 0:
        return 0
    cosine = (first_vector[0] * second_vector[0] + first_vector[1] * second_vector[1]) / (
        first_magnitude * second_magnitude
    )
    return math.degrees(math.acos(clamp(cosine, -1, 1)))


def line_angle(line: FrameLine) -> float:
    return normalize_angle(math.degrees(math.atan2(line.end.y - line.start.y, line.end.x - line.start.x)))


def angle_between_lines(first: FrameLine, second: FrameLine) -> float:
    diff = abs(normalize_angle(line_angle(first) - line_angle(second)))
    return min(diff, 180 - diff)


def joint_angle(first: FramePoint, joint: FramePoint, second: FramePoint) -> float:
    first_vector = (first.x - joint.x, first.y - joint.y)
    second_vector = (second.x - joint.x, second.y - joint.y)
    first_magnitude = math.hypot(*first_vector)
    second_magnitude = math.hypot(*second_vector)
    if first_magnitude == 0 or second_magnitude == 0:
        return 0
    cosine = (
        first_vector[0] * second_vector[0] + first_vector[1] * second_vector[1]
    ) / (first_magnitude * second_magnitude)
    return math.degrees(math.acos(clamp(cosine, -1, 1)))


def normalize_angle(angle: float) -> float:
    while angle > 180:
        angle -= 360
    while angle < -180:
        angle += 360
    return angle


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


# --- Capture endpoints (production: the mobile capture loop) ------------------
# /capture/analyze uploads once and proposes a window (AI when credentials exist,
# null otherwise so the app falls back to manual trim). /capture/record turns a
# confirmed window into the record: trimmed clip + key frames + filmstrip + series.

CAPTURE_DIR = FilePath(tempfile.gettempdir()) / "riderlens-captures"
CAPTURE_TTL_SECONDS = 45 * 60
CAPTURE_MAX_WINDOW_SECONDS = 8.0
UPLOAD_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


def reserve_capture_worker():
    """Allow one MediaPipe record job per machine.

    The mobile app persists the record before processing and automatically retries
    a busy response, so rejecting overlap is safer than letting two large videos
    exhaust the machine together.
    """
    if not CAPTURE_JOB_LOCK.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail="Analysis worker is busy. This record is saved and will retry shortly.",
            headers={"Retry-After": "30"},
        )
    try:
        yield
    finally:
        CAPTURE_JOB_LOCK.release()


def current_rss_mb() -> float | None:
    """Current Linux resident memory for useful Fly diagnostics."""
    try:
        for line in FilePath("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return round(int(line.split()[1]) / 1024, 1)
    except (OSError, ValueError, IndexError):
        pass
    return None


def _cleanup_captures() -> None:
    if not CAPTURE_DIR.exists():
        return
    now = time.time()
    for path in CAPTURE_DIR.iterdir():
        try:
            if now - path.stat().st_mtime > CAPTURE_TTL_SECONDS:
                path.unlink()
        except OSError:
            pass


# Ingest normalization: players honor phone rotation metadata, while OpenCV and
# stream-copy paths can disagree about it. Transcode every upload once so FFmpeg
# applies the display transform to the pixels and clears the metadata. Every
# downstream path then sees the same upright, H.264 source. Oversized footage is
# also bounded to 1080p-class dimensions for pose and filmstrip work.
NORMALIZE_MAX_EDGE = 1920  # cap the longest side, so portrait keeps 1080x1920
NORMALIZE_PIXEL_BUDGET = 1920 * 1088  # anything bigger than ~1080p gets scaled


def _normalize_upload(path: FilePath) -> None:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        return
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    too_big = width * height > NORMALIZE_PIXEL_BUDGET
    if not shutil.which("ffmpeg"):
        return

    normalized = path.with_name(f"{path.stem}-norm.mp4.tmp")
    # FFmpeg autorotation is on by default and runs before this filter. Fit large
    # clips without upscaling; for small clips only make dimensions codec-safe.
    edge = NORMALIZE_MAX_EDGE
    scale = (
        f"scale='min({edge},iw)':'min({edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
        if too_big
        else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    )
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(path),
            "-vf", scale,
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k",
            "-map_metadata", "-1",
            "-metadata:s:v:0", "rotate=0",
            "-movflags", "+faststart",
            "-f", "mp4",  # the .tmp extension would otherwise leave ffmpeg without a container
            str(normalized),
        ],
        capture_output=True,
        timeout=240,
    )
    if result.returncode == 0 and normalized.exists() and normalized.stat().st_size > 0:
        final = path.with_suffix(".mp4")
        path.unlink(missing_ok=True)
        normalized.rename(final)
    else:
        normalized.unlink(missing_ok=True)


def _save_capture_upload(video: UploadFile) -> str:
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    _cleanup_captures()
    upload_id = uuid.uuid4().hex
    suffix = os.path.splitext(video.filename or "clip.mp4")[1] or ".mp4"
    destination = CAPTURE_DIR / f"{upload_id}{suffix}"
    # Stream with a hard cap: an unbounded body could fill the machine's disk.
    max_bytes = int(os.getenv("RIDERLENS_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))
    written = 0
    try:
        with open(destination, "wb") as out:
            while chunk := video.file.read(1024 * 1024):
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Video too large (over {max_bytes // (1024 * 1024)} MB). Trim it shorter and retry.",
                    )
                out.write(chunk)
    except HTTPException:
        destination.unlink(missing_ok=True)
        raise
    try:
        _normalize_upload(destination)
    except Exception:
        # Normalization is an optimization — a failure must never lose the upload.
        pass
    return upload_id


ROTATE_FILTERS = {90: "transpose=1", 180: "hflip,vflip", 270: "transpose=2"}


def _rotated_source(video_path: str, degrees: int) -> str:
    """Clockwise-rotated sibling copy for this record run. The stored upload stays
    pristine so retries carrying the same rotation are idempotent, and the copy
    ages out of CAPTURE_DIR with the regular cleanup."""
    source = FilePath(video_path)
    rotated = source.with_name(f"{source.stem}-rot{degrees}.mp4")
    if rotated.exists() and rotated.stat().st_size > 0:
        return str(rotated)
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(source),
            "-vf", ROTATE_FILTERS[degrees],
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            "-map_metadata", "-1",
            "-metadata:s:v:0", "rotate=0",
            "-movflags", "+faststart",
            "-f", "mp4",
            str(rotated),
        ],
        capture_output=True,
        timeout=240,
    )
    if result.returncode != 0 or not rotated.exists() or rotated.stat().st_size == 0:
        rotated.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not rotate the video.")
    return str(rotated)


def _capture_path(upload_id: str) -> FilePath:
    if not UPLOAD_ID_PATTERN.match(upload_id):
        raise HTTPException(status_code=400, detail="Invalid upload id.")
    path = next(CAPTURE_DIR.glob(f"{upload_id}.*"), None)
    if path is None:
        raise HTTPException(status_code=410, detail="Upload expired. Send the video again.")
    return path


def video_duration_seconds(video_path: str) -> float:
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise HTTPException(status_code=422, detail="Could not open video.")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    capture.release()
    return frame_count / fps if frame_count > 0 else 0.0


def crop_clip(video_path: str, start_seconds: float, end_seconds: float) -> bytes:
    """The trimmed moment clip. FFmpeg stream copy (fast, keyframe-aligned — margins
    absorb the imprecision); cv2 re-encode fallback (no audio) when ffmpeg is missing."""
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        output_path = tmp.name
    try:
        if shutil.which("ffmpeg"):
            result = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-ss", f"{max(0.0, start_seconds):.3f}",
                    "-to", f"{end_seconds:.3f}",
                    "-i", video_path,
                    "-c", "copy", "-movflags", "+faststart",
                    output_path,
                ],
                capture_output=True,
                timeout=120,
            )
            if result.returncode == 0 and os.path.getsize(output_path) > 0:
                with open(output_path, "rb") as clip:
                    return clip.read()

        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            raise HTTPException(status_code=422, detail="Could not open video for cropping.")
        fps = capture.get(cv2.CAP_PROP_FPS) or 30
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        writer = cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
        capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, start_seconds) * 1000.0)
        try:
            while capture.get(cv2.CAP_PROP_POS_MSEC) <= end_seconds * 1000.0:
                ok, frame = capture.read()
                if not ok:
                    break
                writer.write(frame)
        finally:
            writer.release()
            capture.release()
        if os.path.getsize(output_path) == 0:
            raise HTTPException(status_code=422, detail="Could not produce the trimmed clip.")
        with open(output_path, "rb") as clip:
            return clip.read()
    finally:
        try:
            os.unlink(output_path)
        except OSError:
            pass


@app.post("/capture/analyze", dependencies=PROTECTED)
def capture_analyze(
    video: UploadFile = File(...),
    trim_start_seconds: float = Form(0),
    trim_end_seconds: float | None = Form(None),
):
    if not video.content_type or not video.content_type.startswith("video/"):
        raise HTTPException(status_code=415, detail="Upload a video file.")
    if cv2 is None or mp is None or np is None:
        raise HTTPException(status_code=503, detail="Install worker dependencies: mediapipe, opencv-python-headless, numpy.")

    upload_id = _save_capture_upload(video)
    video_path = str(_capture_path(upload_id))
    duration = video_duration_seconds(video_path)

    from .ai_review import AIReviewError, find_key_frames_ai

    window = None
    events: list[dict] = []
    event_type = None
    summary = None
    ai_available = False
    ai_reason = None
    try:
        sheet = build_contact_sheet(video_path, trim_start_seconds, trim_end_seconds)
        if sheet:
            search = find_key_frames_ai(sheet)
            events = search.get("events", [])
            event_type = search.get("event_type")
            summary = search.get("summary")
            window = window_from_events(events)
            ai_available = True
    except AIReviewError as error:
        ai_reason = str(error)

    return {
        "uploadId": upload_id,
        "durationSeconds": round(duration, 2),
        "aiAvailable": ai_available,
        "aiReason": ai_reason,
        "window": window,
        "events": events,
        "eventType": event_type,
        "summary": summary,
    }


@app.post("/capture/record", dependencies=PROTECTED)
def capture_record(
    start_seconds: float = Form(...),
    end_seconds: float = Form(...),
    upload_id: str | None = Form(None),
    video: UploadFile | None = File(None),
    events_json: str | None = Form(None),
    rotate_degrees: int = Form(0),
    _capture_slot: None = Depends(reserve_capture_worker),
):
    if cv2 is None or mp is None or np is None:
        raise HTTPException(status_code=503, detail="Install worker dependencies: mediapipe, opencv-python-headless, numpy.")
    if upload_id is None and video is None:
        raise HTTPException(status_code=422, detail="Provide upload_id or a video file.")
    if video is not None and (not video.content_type or not video.content_type.startswith("video/")):
        raise HTTPException(status_code=415, detail="Upload a video file.")
    if rotate_degrees not in (0, *ROTATE_FILTERS):
        raise HTTPException(status_code=422, detail="rotate_degrees must be 0, 90, 180, or 270.")

    if upload_id is not None:
        video_path = str(_capture_path(upload_id))
    else:
        video_path = str(_capture_path(_save_capture_upload(video)))
    if rotate_degrees:
        video_path = _rotated_source(video_path, rotate_degrees)

    duration = video_duration_seconds(video_path)
    start = max(0.0, min(start_seconds, duration))
    end = max(start + 0.3, min(end_seconds, duration or end_seconds))
    if end - start > CAPTURE_MAX_WINDOW_SECONDS + 1e-6:
        raise HTTPException(
            status_code=422,
            detail=f"Select an analysis window of {CAPTURE_MAX_WINDOW_SECONDS:g} seconds or less.",
        )

    events: list[dict] = []
    if events_json:
        try:
            events = json.loads(events_json)
        except json.JSONDecodeError:
            raise HTTPException(status_code=422, detail="events_json is not valid JSON.")

    started_at = time.perf_counter()
    logger.info(
        "capture_record started window=%.2fs source=%.2fs rss_mb=%s",
        end - start,
        duration,
        current_rss_mb(),
    )
    try:
        # Pose-only records: every filmstrip frame carries the full skeleton; no
        # bike geometry and no separate key-frame metrics. AI reference frames are
        # unused here, so do not allocate them.
        series, _air_frames, filmstrip, overlay_clip = measure_window(
            video_path,
            start,
            end,
            (start, end),
            include_bike=False,
            render_overlay=True,
            include_air_frames=False,
        )
        clip_bytes = crop_clip(video_path, start, end)
    except Exception:
        logger.exception(
            "capture_record failed elapsed=%.1fs rss_mb=%s",
            time.perf_counter() - started_at,
            current_rss_mb(),
        )
        raise

    # Airtime + estimated height from flight physics; null when the events
    # don't describe a takeoff→landing flight (manual windows, no-jump clips).
    from .flight import estimate_flight

    response = {
        "clip": "data:video/mp4;base64," + base64.b64encode(clip_bytes).decode("ascii"),
        # Skeleton-burned, watermarked share version; null if rendering failed.
        "skeletonClip": (
            "data:video/mp4;base64," + base64.b64encode(overlay_clip).decode("ascii") if overlay_clip else None
        ),
        "window": {"start": round(start, 2), "end": round(end, 2)},
        "series": series,
        "filmstrip": filmstrip,
        "events": events,
        "flight": estimate_flight(series, events),
    }
    payload_characters = (
        len(response["clip"])
        + len(response["skeletonClip"] or "")
        + sum(len(frame["image"]) for frame in filmstrip)
        + len(json.dumps(series, separators=(",", ":")))
    )
    logger.info(
        "capture_record completed elapsed=%.1fs frames=%d filmstrip=%d payload_mb=%.1f rss_mb=%s",
        time.perf_counter() - started_at,
        len(series),
        len(filmstrip),
        payload_characters / (1024 * 1024),
        current_rss_mb(),
    )
    return response
