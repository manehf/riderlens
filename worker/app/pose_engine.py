"""Pose engine abstraction: one interface, two implementations.

Every consumer in the worker reads 33 MediaPipe-indexed landmarks with
normalized ``.x``/``.y`` and a ``.visibility`` score. ``MediaPipeEngine``
wraps the legacy BlazePose pipeline unchanged; ``RTMPoseEngine`` runs a
person detector (YOLOX, re-run every ``det_stride`` frames, pose-tracked
between) and RTMPose-halpe26 on the detected crop, then remaps its 26
keypoints into the same 33-slot layout.

Selection: ``POSE_ENGINE=rtmpose|mediapipe`` (default mediapipe, so a bad
deploy can be reverted by unsetting one env var).

The honesty gate lives here: when no rider clears the confidence floor the
engine returns ``None`` and the caller draws nothing — a missing skeleton
reads as honest, a hallucinated one reads as broken.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Landmark:
    x: float
    y: float
    z: float = 0.0
    visibility: float = 0.0


# MediaPipe slot <- halpe26 keypoint. Slots without a source stay at
# visibility 0 (below every drawing/metric threshold in the worker).
MP_FROM_HALPE = {
    0: 0,   # nose
    2: 1,   # left eye
    5: 2,   # right eye
    7: 3,   # left ear
    8: 4,   # right ear
    11: 5,  # left shoulder
    12: 6,  # right shoulder
    13: 7,  # left elbow
    14: 8,  # right elbow
    15: 9,  # left wrist
    16: 10, # right wrist
    23: 11, # left hip
    24: 12, # right hip
    25: 13, # left knee
    26: 14, # right knee
    27: 15, # left ankle
    28: 16, # right ankle
    29: 24, # left heel
    30: 25, # right heel
    31: 20, # left foot index <- left big toe
    32: 21, # right foot index <- right big toe
}

# Cosmetic fills (position only, visibility 0): inner/outer eyes from the eye,
# mouth from the nose, hand points from the wrists.
MP_DERIVED = {1: 2, 3: 2, 4: 5, 6: 5, 9: 0, 10: 0, 17: 15, 19: 15, 21: 15, 18: 16, 20: 16, 22: 16}


class MediaPipeEngine:
    def __init__(self, min_detection_confidence: float = 0.3, min_tracking_confidence: float = 0.3):
        import mediapipe as mp

        self._mp = mp
        self._pose = mp.solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=2,
            enable_segmentation=False,
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
        )

    def process(self, frame_bgr) -> list[Landmark] | None:
        import cv2

        result = self._pose.process(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
        if not result.pose_landmarks:
            return None
        return [
            Landmark(lm.x, lm.y, getattr(lm, "z", 0.0), getattr(lm, "visibility", 0.0))
            for lm in result.pose_landmarks.landmark
        ]

    def close(self) -> None:
        self._pose.close()


class RTMPoseEngine:
    """YOLOX person detection every ``det_stride`` frames, RTMPose in between
    on the box tracked from the previous frame's keypoints. Detection
    bootstraps tracking (pose-only tracking measured useless on this footage);
    periodic re-detection recovers from drift."""

    def __init__(self, det_stride: int = 5, min_score: float = 0.3, mode: str | None = None):
        from rtmlib import BodyWithFeet

        solution = BodyWithFeet(
            mode=mode or os.getenv("RTMPOSE_MODE", "balanced"),
            backend="onnxruntime",
            device="cpu",
        )
        self._det = solution.det_model
        self._pose = solution.pose_model
        self._det_stride = max(1, det_stride)
        self._min_score = min_score
        self._frame_index = 0
        self._tracked_box: list[float] | None = None

    def process(self, frame_bgr) -> list[Landmark] | None:
        import numpy as np

        height, width = frame_bgr.shape[:2]
        run_detector = self._tracked_box is None or self._frame_index % self._det_stride == 0
        self._frame_index += 1

        boxes = None
        if run_detector:
            detected = self._det(frame_bgr)
            if detected is not None and len(detected) > 0:
                boxes = detected
        if boxes is None:
            if self._tracked_box is None:
                return None
            boxes = np.asarray([self._tracked_box])

        keypoints, scores = self._pose(frame_bgr, bboxes=boxes)
        if len(scores) == 0:
            self._tracked_box = None
            return None

        best = int(np.argmax(np.median(scores, axis=1)))
        points, confidences = keypoints[best], scores[best]
        if float(np.median(confidences)) < self._min_score:
            self._tracked_box = None
            return None

        confident = points[confidences > self._min_score]
        if len(confident) >= 4:
            x0, y0 = confident.min(axis=0)
            x1, y1 = confident.max(axis=0)
            margin_x, margin_y = 0.35 * (x1 - x0), 0.35 * (y1 - y0)
            self._tracked_box = [
                max(0.0, float(x0 - margin_x)),
                max(0.0, float(y0 - margin_y)),
                min(float(width), float(x1 + margin_x)),
                min(float(height), float(y1 + margin_y)),
            ]

        landmarks = [Landmark(0.0, 0.0) for _ in range(33)]
        for mp_index, halpe_index in MP_FROM_HALPE.items():
            landmarks[mp_index] = Landmark(
                float(points[halpe_index][0]) / width,
                float(points[halpe_index][1]) / height,
                0.0,
                float(confidences[halpe_index]),
            )
        for mp_index, source_index in MP_DERIVED.items():
            source = landmarks[source_index]
            landmarks[mp_index] = Landmark(source.x, source.y, 0.0, 0.0)
        return landmarks

    def close(self) -> None:
        pass


def create_pose_engine(
    min_detection_confidence: float = 0.3,
    min_tracking_confidence: float = 0.3,
):
    """Factory honoring POSE_ENGINE; per-call confidences apply to MediaPipe,
    RTMPose uses its own score floor."""
    if os.getenv("POSE_ENGINE", "mediapipe").strip().lower() == "rtmpose":
        return RTMPoseEngine()
    return MediaPipeEngine(min_detection_confidence, min_tracking_confidence)
