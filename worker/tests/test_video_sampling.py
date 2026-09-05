"""Sampling tests use decoder timestamps, including variable-frame-rate input."""

import shutil
import subprocess

import pytest

import app.main as main


class TimestampCapture:
    def __init__(self, times, missing_timestamps=False, frame_offset=0):
        self.times = times
        self.index = -1
        self.missing_timestamps = missing_timestamps
        self.frame_offset = frame_offset

    def read(self):
        self.index += 1
        return (True, self.index) if self.index < len(self.times) else (False, None)

    def get(self, prop):
        if prop == main.cv2.CAP_PROP_POS_MSEC:
            return 0 if self.missing_timestamps else self.times[self.index] * 1000
        if prop == main.cv2.CAP_PROP_POS_FRAMES:
            return self.frame_offset + self.index + 1
        raise AssertionError(prop)


def test_variable_frame_rate_is_resampled_without_shortening_playback():
    capture = TimestampCapture([0, 0.1, 0.2, 0.5, 0.6, 0.7, 0.8])
    frames = list(main.sample_window_frames(capture, 0, 0.8, source_fps=10, output_fps=10))
    assert [t for t, _ in frames] == pytest.approx([i / 10 for i in range(8)])
    # The source holds a frame through its timestamp gap; the output must too.
    assert [frame for _, frame in frames] == [0, 1, 2, 2, 3, 3, 4, 5]


def test_missing_decoder_timestamps_use_source_frame_positions():
    capture = TimestampCapture([i / 30 for i in range(30)], missing_timestamps=True)
    frames = list(main.sample_window_frames(capture, 0, 1, source_fps=30, output_fps=30))
    assert len(frames) == 30
    assert [frame for _, frame in frames] == list(range(30))


def test_eof_does_not_fill_the_rest_of_an_invalid_window():
    capture = TimestampCapture([0, 0.1, 0.2])
    frames = list(main.sample_window_frames(capture, 0, 8, source_fps=10, output_fps=10))
    assert len(frames) == 3


def test_sampling_does_not_choose_a_frame_outside_the_window():
    capture = TimestampCapture([0, 0.15, 0.31])
    frames = list(main.sample_window_frames(capture, 0, 0.3, source_fps=10, output_fps=10))
    assert len(frames) == 3
    assert all(frame < 2 for _, frame in frames)


def test_missing_timestamps_after_a_seek_keep_the_absolute_time():
    capture = TimestampCapture([0] * 60, missing_timestamps=True, frame_offset=300)
    frames = list(main.sample_window_frames(capture, 10.05, 11.05, source_fps=30, output_fps=30))
    assert len(frames) == 30
    for t, index in frames:
        assert (300 + index) / 30 == pytest.approx(t, abs=1 / 30)


def test_sampler_respects_the_hard_frame_ceiling():
    capture = TimestampCapture([i / 60 for i in range(700)])
    assert len(list(main.sample_window_frames(capture, 0, 10, 60, 60))) == 480


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is needed to generate VFR footage")
def test_real_vfr_decoder_keeps_the_timestamp_gap(tmp_path):
    source = tmp_path / "variable.mp4"
    pixels = main.np.stack([
        main.np.full((90, 160, 3), 16 + i * 20, dtype=main.np.uint8) for i in range(10)
    ])
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", "160x90", "-r", "10", "-i", "-",
         "-vf", r"select=not(between(n\,3\,4))", "-fps_mode", "vfr",
         "-c:v", "libx264", "-crf", "0", "-bf", "0", str(source)],
        input=pixels.tobytes(), capture_output=True, check=True, timeout=30,
    )
    capture = main.cv2.VideoCapture(str(source))
    try:
        frames = list(main.sample_window_frames(capture, 0, 0.8, capture.get(main.cv2.CAP_PROP_FPS), 10))
    finally:
        capture.release()
    assert [t for t, _ in frames] == pytest.approx([i / 10 for i in range(8)])
    assert [float(frame.mean()) for _, frame in frames] == pytest.approx(
        [16, 36, 56, 56, 116, 116, 136, 156], abs=2,
    )
