"""Ingest normalization: source orientation is baked once into canonical pixels."""

import json
import shutil
import subprocess
from pathlib import Path

import cv2
import pytest

from app.main import NORMALIZE_MAX_EDGE, _normalize_upload

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg and ffprobe are required",
)


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


def encoded_dims(path):
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    stream = json.loads(result.stdout)["streams"][0]
    return stream["width"], stream["height"]


def display_rotation(path):
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream_tags=rotate:stream_side_data=rotation",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    stream = json.loads(result.stdout)["streams"][0]
    if "rotate" in stream.get("tags", {}):
        return int(stream["tags"]["rotate"])
    for side_data in stream.get("side_data_list", []):
        if "rotation" in side_data:
            return int(side_data["rotation"])
    return None


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


def test_small_upload_is_canonicalized_without_resizing(tmp_path):
    clip = tmp_path / "clip.mp4"
    synth_clip(clip, 1280, 720)

    _normalize_upload(clip)

    assert dims(clip) == (1280, 720)
    assert encoded_dims(clip) == (1280, 720)
    assert display_rotation(clip) is None


def test_phone_rotation_metadata_is_baked_once_and_removed(tmp_path):
    source = tmp_path / "source.mp4"
    clip = tmp_path / "clip.mp4"
    synth_clip(source, 640, 360)
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-display_rotation", "90",
            "-i", str(source), "-c", "copy", str(clip),
        ],
        check=True,
    )
    assert abs(display_rotation(clip)) == 90

    _normalize_upload(clip)

    assert encoded_dims(clip) == (360, 640)
    assert display_rotation(clip) is None


def test_rotated_source_swaps_dimensions_and_is_reused(tmp_path):
    from app.main import _rotated_source

    clip = tmp_path / "clip.mp4"
    synth_clip(clip, 640, 360)

    rotated = _rotated_source(str(clip), 90)
    assert dims(rotated) == (360, 640)
    first_mtime = Path(rotated).stat().st_mtime
    assert _rotated_source(str(clip), 90) == rotated  # retry reuses the copy
    assert Path(rotated).stat().st_mtime == first_mtime
