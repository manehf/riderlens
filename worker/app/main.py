from __future__ import annotations

import math
import os
import shutil
import tempfile
from dataclasses import dataclass
from typing import Literal

os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "riderlens-matplotlib"))

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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


@app.post("/analysis/regular-jump", response_model=AnalyzeResponse)
async def analyze_regular_jump_upload(
    video: UploadFile = File(...),
    session_id: str = Form(...),
    trim_start_seconds: float = Form(0),
    trim_end_seconds: float | None = Form(None),
    crop_preset: CropPreset = Form("full_side_view"),
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
    metrics = [build_metric(session_id, phase, pose_frame, fps) for phase, pose_frame in selected]
    return AnalyzeResponse(status="completed", metrics=metrics, report=build_report(metrics))


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

    floor = detect_floor_line(pose_frame.frame)
    detected_tire_baseline = detect_tire_baseline(pose_frame.frame)
    tire_baseline = detected_tire_baseline or estimated_tire_baseline(ankle, foot)
    landing = floor
    geometry_source: GeometrySource = "detected"
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


def detect_floor_line(frame) -> FrameLine:
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 60, 140)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=70, minLineLength=int(width * 0.22), maxLineGap=24)

    best = None
    best_score = -1.0
    if lines is not None:
        for line in lines[:, 0]:
            x1, y1, x2, y2 = [int(value) for value in line]
            angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
            midpoint_y = (y1 + y2) / 2
            length = math.hypot(x2 - x1, y2 - y1)
            if abs(angle) > 35 or midpoint_y < height * 0.45:
                continue
            score = length + midpoint_y * 0.35
            if score > best_score:
                best_score = score
                best = (x1, y1, x2, y2)

    if best is None:
        y = 0.88
        return FrameLine(start=FramePoint(x=0.08, y=y), end=FramePoint(x=0.92, y=y))

    x1, y1, x2, y2 = best
    return FrameLine(
        start=FramePoint(x=clamp(x1 / width, 0, 1), y=clamp(y1 / height, 0, 1)),
        end=FramePoint(x=clamp(x2 / width, 0, 1), y=clamp(y2 / height, 0, 1)),
    )


def detect_tire_baseline(frame) -> FrameLine | None:
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)
    min_radius = max(8, int(min(width, height) * 0.035))
    max_radius = max(min_radius + 4, int(min(width, height) * 0.18))
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(24, width * 0.18),
        param1=90,
        param2=24,
        minRadius=min_radius,
        maxRadius=max_radius,
    )
    if circles is None:
        return None

    candidates = []
    for x, y, radius in np.round(circles[0, :]).astype("int"):
        if y < height * 0.25 or radius < min_radius:
            continue
        candidates.append((x, y, radius))
    if len(candidates) < 2:
        return None

    best_pair = None
    best_distance = 0.0
    for index, first in enumerate(candidates):
        for second in candidates[index + 1 :]:
            distance = abs(first[0] - second[0])
            if distance > best_distance:
                best_distance = distance
                best_pair = (first, second)
    if best_pair is None:
        return None

    first, second = sorted(best_pair, key=lambda circle: circle[0])
    return FrameLine(
        start=FramePoint(x=clamp(first[0] / width, 0, 1), y=clamp(first[1] / height, 0, 1)),
        end=FramePoint(x=clamp(second[0] / width, 0, 1), y=clamp(second[1] / height, 0, 1)),
    )


def estimated_tire_baseline(ankle: FramePoint, foot: FramePoint) -> FrameLine:
    center_x = clamp((ankle.x + foot.x) / 2, 0.18, 0.82)
    center_y = clamp(max(ankle.y, foot.y) + 0.12, 0.35, 0.92)
    return FrameLine(
        start=FramePoint(x=clamp(center_x - 0.22, 0, 1), y=center_y),
        end=FramePoint(x=clamp(center_x + 0.22, 0, 1), y=center_y),
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
