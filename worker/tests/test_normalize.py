"""Ingest normalization: oversized uploads are transcoded down, orientation preserved."""

import shutil
import subprocess
from pathlib import Path

import cv2
import pytest

from app.main import NORMALIZE_MAX_EDGE, _normalize_upload

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def synth_clip(path, width, height):
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc=size={width}x{height}:rate=30:duration=0.2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(path),
        ],
        check=True,
    )


def dims(path):
    capture = cv2.VideoCapture(str(path))
    try:
        return (
            int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
            int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        )
    finally:
        capture.release()


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ((3840, 2160), (1920, 1080)),  # landscape 4K
        ((2160, 3840), (1080, 1920)),  # portrait 4K keeps its orientation
    ],
)
def test_oversized_upload_is_scaled_to_max_edge(tmp_path, source, expected):
    clip = tmp_path / "clip.mp4"
    synth_clip(clip, *source)

    _normalize_upload(clip)

    assert dims(clip) == expected
    assert max(dims(clip)) == NORMALIZE_MAX_EDGE


def test_small_upload_is_left_alone(tmp_path):
    clip = tmp_path / "clip.mp4"
    synth_clip(clip, 1280, 720)
    before = clip.stat().st_size

    _normalize_upload(clip)

    assert dims(clip) == (1280, 720)
    assert clip.stat().st_size == before  # untouched, not re-encoded


def test_rotated_source_swaps_dimensions_and_is_reused(tmp_path):
    from app.main import _rotated_source

    clip = tmp_path / "clip.mp4"
    synth_clip(clip, 640, 360)

    rotated = _rotated_source(str(clip), 90)
    assert dims(rotated) == (360, 640)
    first_mtime = Path(rotated).stat().st_mtime
    assert _rotated_source(str(clip), 90) == rotated  # retry reuses the copy
    assert Path(rotated).stat().st_mtime == first_mtime
