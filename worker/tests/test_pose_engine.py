from app.pose_engine import (
    HOLD_DECAY,
    Landmark,
    MP_FROM_HALPE,
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
