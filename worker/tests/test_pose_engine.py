import sys
from types import SimpleNamespace

import numpy as np

from app.pose_engine import (
    HOLD_DECAY,
    Landmark,
    MP_FROM_HALPE,
    RTMPoseEngine,
    fade_landmarks,
    suppress_teleports,
)


def full_pose(visibility: float = 0.9, shift: float = 0.0) -> list[Landmark]:
    pose = [Landmark(0.0, 0.0, 0.0, 0.0) for _ in range(33)]
    for offset, index in enumerate(MP_FROM_HALPE):
        pose[index] = Landmark(0.3 + offset * 0.01 + shift, 0.5 + offset * 0.005 + shift, 0.0, visibility)
    return pose


def test_fade_decays_visibility_but_keeps_positions():
    pose = full_pose(visibility=0.8)
    faded = fade_landmarks(pose)
    assert faded[11].x == pose[11].x
    assert faded[11].visibility == 0.8 * HOLD_DECAY
    # Two consecutive holds fall below the 0.5 drawing threshold.
    assert fade_landmarks(faded)[11].visibility < 0.5


def test_ordinary_motion_passes_untouched():
    before = full_pose()
    after = full_pose(shift=0.01)  # coherent whole-body motion
    result = suppress_teleports(before, after)
    assert result[23].x == after[23].x
    assert result[23].visibility == after[23].visibility


def test_single_joint_teleport_is_held_at_previous_position():
    before = full_pose()
    after = full_pose(shift=0.005)
    wrist = 15
    after[wrist] = Landmark(after[wrist].x + 0.4, after[wrist].y - 0.3, 0.0, 0.9)  # jumps to a tree
    result = suppress_teleports(before, after)
    assert result[wrist].x == before[wrist].x
    assert result[wrist].visibility == before[wrist].visibility * 0.5
    # neighbors untouched
    assert result[13].x == after[13].x


def test_low_visibility_joints_are_ignored_not_vetoed():
    before = full_pose()
    after = full_pose(shift=0.005)
    after[27] = Landmark(0.9, 0.9, 0.0, 0.1)  # unreliable anyway; drawing skips it
    result = suppress_teleports(before, after)
    assert result[27].x == after[27].x


def test_sparse_overlap_returns_current_unchanged():
    before = [Landmark(0.0, 0.0, 0.0, 0.0) for _ in range(33)]
    after = full_pose()
    assert suppress_teleports(before, after) is not None
    assert suppress_teleports(before, after)[11].x == after[11].x


def tracking_engine(monkeypatch, detections, rider_visible=lambda: True):
    """Exercise the production engine while replacing only ONNX inference."""
    def pose(frame, bboxes):
        points = np.zeros((len(bboxes), 26, 2))
        scores = np.zeros((len(bboxes), 26))
        for i, box in enumerate(bboxes):
            x0, y0, x1, y1 = box
            points[i, :, 0] = np.linspace(x0 + (x1 - x0) * 0.2, x1 - (x1 - x0) * 0.2, 26)
            points[i, :, 1] = np.linspace(y0 + (y1 - y0) * 0.2, y1 - (y1 - y0) * 0.2, 26)
            scores[i, :] = (0.75 if rider_visible() else 0.05) if x0 < 500 else 0.98
        return points, scores

    solution = SimpleNamespace(det_model=lambda frame: next(detections), pose_model=pose)
    monkeypatch.setitem(sys.modules, "rtmlib", SimpleNamespace(BodyWithFeet=lambda **kwargs: solution))
    return RTMPoseEngine(det_stride=1)


RIDER = [100, 100, 300, 800]
BYSTANDER = [650, 100, 850, 800]


def test_redetection_keeps_the_rider_despite_a_more_confident_bystander(monkeypatch):
    engine = tracking_engine(monkeypatch, iter([
        np.array([RIDER]), np.array([BYSTANDER, RIDER]), np.array([RIDER, BYSTANDER]),
    ]))
    frame = np.zeros((1000, 1000, 3), dtype=np.uint8)
    poses = [engine.process(frame) for _ in range(3)]
    assert all(pose is not None and pose[0].x < 0.5 for pose in poses)


def test_lost_rider_is_not_replaced_by_a_distant_person(monkeypatch):
    visible = True
    engine = tracking_engine(
        monkeypatch,
        iter([np.array([RIDER])] + [np.array([BYSTANDER])] * 5 + [np.array([RIDER, BYSTANDER])]),
        rider_visible=lambda: visible,
    )
    frame = np.zeros((1000, 1000, 3), dtype=np.uint8)
    assert engine.process(frame) is not None
    visible = False
    missed = [engine.process(frame) for _ in range(5)]
    assert all(pose is None or pose[0].x < 0.5 for pose in missed)
    assert missed[-1] is None
    visible = True
    recovered = engine.process(frame)
    assert recovered is not None and recovered[0].x < 0.5


def test_initial_target_selection_still_uses_pose_confidence(monkeypatch):
    engine = tracking_engine(monkeypatch, iter([np.array([RIDER, BYSTANDER])]))
    pose = engine.process(np.zeros((1000, 1000, 3), dtype=np.uint8))
    # Without an established track there is no rider identity signal yet.
    assert pose is not None and pose[0].x > 0.5


def test_small_rider_movement_remains_trackable(monkeypatch):
    moved = [160, 100, 360, 800]
    engine = tracking_engine(monkeypatch, iter([np.array([RIDER]), np.array([moved, BYSTANDER])]))
    frame = np.zeros((1000, 1000, 3), dtype=np.uint8)
    first = engine.process(frame)
    second = engine.process(frame)
    assert first is not None and second is not None
    assert first[0].x < second[0].x < 0.5
