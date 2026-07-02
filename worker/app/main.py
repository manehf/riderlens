from __future__ import annotations

import base64
import json
import math
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path as FilePath
from typing import Literal

os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "riderlens-matplotlib"))

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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


app = FastAPI(title="RiderLens Analysis Worker", version="0.2.0")

SkillType = Literal["regular_jump", "bunnyhop", "manual", "wheelie", "drop"]
CropPreset = Literal["full_side_view", "rider_centered", "takeoff_landing", "vertical_social"]
Phase = Literal["approach", "compression", "takeoff", "air", "landing"]
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
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not service_role_key or create_client is None:
        return None
    return create_client(url, service_role_key)


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "riderlens-worker",
        "mediapipe": mp is not None,
        "opencv": cv2 is not None,
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


class DevAnalyzeRequest(BaseModel):
    file: str
    trim_start_seconds: float = Field(default=0, ge=0)
    trim_end_seconds: float | None = Field(default=None, ge=0)


@app.post("/dev/analyze-clip", response_model=AnalyzeResponse)
def dev_analyze_clip(request: DevAnalyzeRequest):
    require_dev_ui()
    clips_root = CLIPS_DIR.resolve()
    clip_path = (clips_root / request.file).resolve()
    if clips_root not in clip_path.parents:
        raise HTTPException(status_code=400, detail="Clip path must stay inside the clips directory.")
    if not clip_path.exists():
        raise HTTPException(status_code=404, detail=f"Clip not found: {request.file}")

    return analyze_regular_jump_file(
        session_id=f"dev-{re.sub(r'[^A-Za-z0-9_-]', '-', request.file)}",
        video_path=str(clip_path),
        trim_start_seconds=request.trim_start_seconds,
        trim_end_seconds=request.trim_end_seconds,
        crop_preset="full_side_view",
        include_frames=True,
    )


@app.post("/analysis/regular-jump", response_model=AnalyzeResponse)
async def analyze_regular_jump_upload(
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


@app.post("/jobs/{job_id}/analyze", response_model=AnalyzeResponse)
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
        supabase.table("analysis_jobs").update({"status": "processing", "progress": 0.2}).eq("id", job_id).execute()

    response = analyze_regular_jump_file(
        session_id=request.session_id,
        video_path=request.raw_video_path,
        trim_start_seconds=request.trim_start_seconds,
        trim_end_seconds=request.trim_end_seconds,
        crop_preset=request.crop_preset,
    )

    if supabase:
        for metric in response.metrics:
            supabase.table("pose_metrics").insert(
                {
                    "session_id": request.session_id,
                    "phase": metric.phase,
                    "frame_time": metric.frameTime,
                    "torso_angle": metric.torsoAngle,
                    "hip_angle": metric.hipAngle,
                    "knee_angle": metric.kneeAngle,
                    "elbow_angle": metric.elbowAngle,
                    "bike_pitch_angle": metric.bikePitchAngle,
                    "confidence": metric.confidence,
                }
            ).execute()
        supabase.table("reports").insert(
            {
                "session_id": request.session_id,
                "summary": response.report.summary,
                "strengths": response.report.strengths,
                "improvements": response.report.improvements,
                "drills": response.report.drills,
            }
        ).execute()
        supabase.table("analysis_jobs").update({"status": "completed", "progress": 1}).eq("id", job_id).execute()
        supabase.table("sessions").update({"status": "complete"}).eq("id", request.session_id).execute()

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
        model_complexity=1,
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

    rear_pred, front_pred, wheel_radius = estimate_wheel_geometry(
        shoulder=to_px(shoulder), hip=to_px(hip), ankle=to_px(ankle), foot=to_px(foot), wrist=to_px(wrist)
    )
    # Wheel/floor confirmation is anchored to the pose; with a low-confidence pose the
    # anchors are unreliable and "confirmations" are usually background texture.
    trustworthy_pose = pose_frame.confidence >= 0.8
    gray = cv2.medianBlur(cv2.cvtColor(pose_frame.frame, cv2.COLOR_BGR2GRAY), 5)
    rear_hit = confirm_wheel_circle(gray, rear_pred, wheel_radius) if trustworthy_pose else None
    front_hit = confirm_wheel_circle(gray, front_pred, wheel_radius) if trustworthy_pose else None
    tires_detected = rear_hit is not None and front_hit is not None
    rear_center = rear_hit or rear_pred
    front_center = front_hit or front_pred
    tire_baseline = px_line(rear_center, front_center, width, height)

    wheel_bottom_y = max(rear_center[1], front_center[1]) + wheel_radius
    bike_x_range = (min(rear_center[0], front_center[0]) - wheel_radius, max(rear_center[0], front_center[0]) + wheel_radius)
    detected_floor = detect_floor_line(pose_frame.frame, wheel_bottom_y, bike_x_range) if trustworthy_pose else None
    floor = detected_floor or estimated_floor_line(wheel_bottom_y, bike_x_range, width, height)
    landing = floor
    geometry_source: GeometrySource = "detected" if detected_floor is not None and tires_detected else "estimated"
    geometry = FrameGeometry(
        floor=floor,
        tireBaseline=tire_baseline,
        torso=FrameLine(start=hip, end=shoulder),
        kneeUpper=FrameLine(start=hip, end=knee),
        kneeLower=FrameLine(start=knee, end=ankle),
        landing=landing,
    )

    floor_angle = line_angle(floor)
    tire_angle = line_angle(tire_baseline)
    landing_angle = line_angle(landing)
    torso_angle = angle_between_lines(FrameLine(start=hip, end=shoulder), floor)
    hip_angle = joint_angle(shoulder, hip, knee)
    knee_angle = joint_angle(hip, knee, ankle)
    elbow_angle = joint_angle(shoulder, elbow, wrist)
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


def encode_frame_jpeg(frame) -> str | None:
    ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
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
