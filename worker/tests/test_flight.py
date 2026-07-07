"""Tests for flight metrics: airtime + height from the pose series."""

import pytest

from app.flight import GRAVITY, estimate_flight


def make_series(
    takeoff: float,
    landing: float,
    apex: float,
    *,
    ground: float = 0.45,
    fps: float = 30.0,
    start: float = 0.0,
    end: float = 3.0,
) -> list[dict]:
    """Hip trace in normalized units: flat on the ground, a parabola through
    the apex while airborne, flat again after landing. The parabola's vertical
    scale is arbitrary (pixels aren't meters) — only its timing matters."""
    curvature = 0.9  # normalized units / s^2, sign flipped below
    series = []
    steps = int((end - start) * fps) + 1
    for index in range(steps):
        t = start + index / fps
        if takeoff <= t <= landing:
            height = ground + curvature * ((apex - takeoff) ** 2 - (t - apex) ** 2)
        else:
            height = ground
        series.append({"t": round(t, 3), "hipHeight": round(height, 3), "confidence": 0.9})
    return series


def events_at(takeoff: float, landing: float) -> list[dict]:
    return [
        {"name": "takeoff", "time_seconds": takeoff, "why": ""},
        {"name": "landing", "time_seconds": landing, "why": ""},
    ]


def test_symmetric_jump_snaps_coarse_events_to_series():
    # True flight 1.00s..1.80s; AI events are off by ~0.12s each way.
    series = make_series(takeoff=1.0, landing=1.8, apex=1.4)
    flight = estimate_flight(series, events_at(1.12, 1.68))

    assert flight is not None
    assert flight["method"] == "symmetric"
    assert flight["airtimeSeconds"] == pytest.approx(0.8, abs=0.08)
    assert flight["heightMeters"] == pytest.approx(GRAVITY * 0.8**2 / 8, abs=0.15)
    # Snapping should beat the coarse events, not just echo them.
    assert flight["takeoffTime"] == pytest.approx(1.0, abs=0.05)
    assert flight["landingTime"] == pytest.approx(1.8, abs=0.05)


def test_step_down_uses_rise_time_formula():
    # Landing lower than takeoff: apex at 1.4 but flight continues to 2.2.
    series = make_series(takeoff=1.0, landing=2.2, apex=1.4)
    flight = estimate_flight(series, events_at(1.05, 2.15))

    assert flight is not None
    assert flight["method"] == "rise_time"
    # Height from the rise only: 0.5 * g * 0.4^2, not g * 1.2^2 / 8.
    assert flight["heightMeters"] == pytest.approx(0.5 * GRAVITY * 0.4**2, abs=0.15)


def test_crash_ends_the_flight_and_heights_from_rise_only():
    # Real crash clips get takeoff + crash, no landing event.
    series = make_series(takeoff=1.0, landing=1.9, apex=1.4)
    events = [
        {"name": "takeoff", "time_seconds": 1.05, "why": ""},
        {"name": "peak_air", "time_seconds": 1.42, "why": ""},
        {"name": "crash", "time_seconds": 1.85, "why": ""},
    ]
    flight = estimate_flight(series, events)

    assert flight is not None
    assert flight["endedIn"] == "crash"
    assert flight["method"] == "rise_time"
    assert flight["airtimeSeconds"] == pytest.approx(0.9, abs=0.1)
    assert flight["heightMeters"] == pytest.approx(0.5 * GRAVITY * 0.4**2, abs=0.15)


def test_no_flight_without_takeoff_and_landing_events():
    series = make_series(takeoff=1.0, landing=1.8, apex=1.4)
    assert estimate_flight(series, []) is None
    assert estimate_flight(series, [{"name": "takeoff", "time_seconds": 1.0, "why": ""}]) is None


def test_rejects_implausible_airtime():
    series = make_series(takeoff=1.0, landing=1.05, apex=1.02)
    assert estimate_flight(series, events_at(1.0, 1.05)) is None


def test_sparse_series_falls_back_to_event_times():
    # Too few confident points to fit: use the AI times as-is.
    series = [{"t": 1.2, "hipHeight": 0.5, "confidence": 0.9}]
    flight = estimate_flight(series, events_at(1.0, 1.8))

    assert flight is not None
    assert flight["airtimeSeconds"] == pytest.approx(0.8, abs=0.01)
    assert flight["method"] == "symmetric"


def test_endcard_builds_scannable_frame():
    from app.main import build_endcard

    frame = build_endcard(960, 540)
    assert frame.shape == (540, 960, 3)
    # The QR tile must contain both true white and dark modules.
    assert frame.max() >= 250
    center = frame[200:420, 300:660]
    assert (center < 40).any() and (center > 220).any()
