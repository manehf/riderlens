import base64

import pytest

import app.main as main


@pytest.mark.parametrize("shape", [(720, 1280, 3), (1920, 1080, 3)])
def test_detailed_images_fit_the_per_frame_budget(shape):
    frame = main.np.random.default_rng(10).integers(0, 256, shape, dtype=main.np.uint8)
    budget = 26_000
    image = main.encode_filmstrip_frame(frame, quality=76, max_characters=budget)
    assert image.startswith("data:image/jpeg;base64,")
    assert len(image) <= budget
    decoded = main.cv2.imdecode(
        main.np.frombuffer(base64.b64decode(image.split(",", 1)[1]), dtype=main.np.uint8),
        main.cv2.IMREAD_COLOR,
    )
    assert decoded is not None
    assert decoded.shape[1] / decoded.shape[0] == pytest.approx(shape[1] / shape[0], rel=0.02)


def test_small_frames_are_not_recompressed_unnecessarily():
    frame = main.np.full((180, 320, 3), 70, dtype=main.np.uint8)
    original = main.encode_frame_jpeg(frame, quality=85)
    assert main.encode_filmstrip_frame(frame, quality=85, max_characters=200_000) == original


def test_measure_window_bounds_filmstrip_without_removing_frames(monkeypatch, tmp_path):
    class NoPose:
        def process(self, frame):
            return None

        def close(self):
            pass

    monkeypatch.setattr(main, "create_pose_engine", lambda **kwargs: NoPose())
    monkeypatch.setattr(main, "FILMSTRIP_MAX_CHARACTERS", 1024 * 1024)
    source = tmp_path / "source.avi"
    writer = main.cv2.VideoWriter(str(source), main.cv2.VideoWriter_fourcc(*"MJPG"), 30, (640, 360))
    assert writer.isOpened()
    rng = main.np.random.default_rng(11)
    for _ in range(60):
        writer.write(rng.integers(0, 256, (360, 640, 3), dtype=main.np.uint8))
    writer.release()
    series, _, filmstrip, _ = main.measure_window(
        str(source), 0, 2, (0, 2), include_bike=False, include_air_frames=False,
    )
    assert len(series) == len(filmstrip) == 60
    assert sum(len(frame["image"]) for frame in filmstrip) <= main.FILMSTRIP_MAX_CHARACTERS
