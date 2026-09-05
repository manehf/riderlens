"""A failed analysis must not leave an encoder running or an MP4 behind."""

import io
import shutil
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest

import app.main as main


def test_overlay_timeout_kills_and_reaps_the_encoder(tmp_path):
    overlay = main.OverlayClipWriter(fps=30)
    output = tmp_path / "partial.mp4"
    output.write_bytes(b"incomplete")
    process = Mock(stdin=io.BytesIO())
    process.poll.return_value = None
    process.wait.side_effect = [subprocess.TimeoutExpired("ffmpeg", 120), -9]
    overlay.process = process
    overlay.output_path = str(output)

    assert overlay.finalize() is None
    process.kill.assert_called_once()
    assert process.wait.call_count == 2
    assert process.stdin.closed
    assert not output.exists()
    overlay.close()  # repeated cleanup is harmless


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="Requires the production encoder")
def test_analysis_failure_cleans_up_a_running_encoder(monkeypatch, tmp_path):
    source = tmp_path / "source.avi"
    writer = main.cv2.VideoWriter(str(source), main.cv2.VideoWriter_fourcc(*"MJPG"), 30, (160, 90))
    assert writer.isOpened()
    for _ in range(5):
        writer.write(main.np.zeros((90, 160, 3), dtype=main.np.uint8))
    writer.release()

    pose = Mock()
    pose.process.side_effect = [None, RuntimeError("inference failed")]
    monkeypatch.setattr(main, "create_pose_engine", lambda **kwargs: pose)
    encoders = []

    class RecordingWriter(main.OverlayClipWriter):
        def add(self, frame):
            super().add(frame)
            encoders.append((self.process, self.output_path))

    monkeypatch.setattr(main, "OverlayClipWriter", RecordingWriter)
    with pytest.raises(RuntimeError, match="inference failed"):
        main.measure_window(
            str(source), 0, 0.1, (0, 0.1), include_bike=False,
            include_air_frames=False, render_overlay=True,
        )
    pose.close.assert_called_once()
    assert encoders
    for process, path in encoders:
        assert process is not None and process.poll() is not None
        assert not Path(path).exists()
