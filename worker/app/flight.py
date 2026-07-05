"""Flight metrics from the pose series: airtime and estimated air height.

Physics: once the wheels leave the lip the rider+bike is a projectile, so the
hip trace follows a parabola in time. Time is the precisely known quantity
(the series is sampled at video rate), so airtime converts to height with no
pixel-to-meter calibration: h = g*T^2/8 for a symmetric flight, or
h = 0.5*g*rise^2 from the apex when takeoff and landing heights differ.

The AI events place takeoff/landing only to the nearest contact-sheet frame,
and height error grows quadratically with timing error. So both bounds are
snapped to the dense series: fit the flight parabola to the interior of the
AI window, then extend each bound outward while the hip trace keeps following
that parabola — the first departure is ground contact.
"""

from __future__ import annotations

try:  # pragma: no cover - numpy is a hard dep of the worker, soft here for parity with main
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

GRAVITY = 9.81
# How far a snapped bound may move from the AI guess, seconds.
SNAP_WINDOW_SECONDS = 0.35
# Sanity bounds: outside this range the events are mislabeled, not a jump.
MIN_AIRTIME_SECONDS = 0.15
MAX_AIRTIME_SECONDS = 3.0
# Interior points needed for a trustworthy parabola fit.
MIN_FIT_POINTS = 6
# Pose points below this confidence are too jittery to snap against.
MIN_CONFIDENCE = 0.3
# Rise/fall imbalance beyond this fraction of airtime → asymmetric landing,
# use the rise-time formula instead of the symmetric one.
ASYMMETRY_THRESHOLD = 0.25


def _event_time(events: list[dict], name: str) -> float | None:
    for event in events:
        if event.get("name") == name and isinstance(event.get("time_seconds"), (int, float)):
            return float(event["time_seconds"])
    return None


def _snap_bounds(
    points: list[tuple[float, float]], takeoff: float, landing: float
) -> tuple[float, float, float | None]:
    """Refine (takeoff, landing) against the hip trace. Returns the refined
    bounds plus the parabola apex time, or the AI times unchanged when the
    series is too sparse or the fit is not a downward-opening arc."""
    span = landing - takeoff
    margin = 0.15 * span
    inner = [(t, h) for t, h in points if takeoff + margin <= t <= landing - margin]
    if np is None or len(inner) < MIN_FIT_POINTS:
        return takeoff, landing, None

    times = np.array([t for t, _ in inner])
    heights = np.array([h for _, h in inner])
    a, b, c = np.polyfit(times, heights, 2)
    if a >= 0:  # not an arc opening downward — do not trust the fit
        return takeoff, landing, None

    fitted = np.polyval((a, b, c), times)
    # Tolerance: at least ~1% of frame height, or 2.5x the interior fit noise.
    tolerance = max(0.008, 2.5 * float(np.sqrt(np.mean((heights - fitted) ** 2))))

    def follows_parabola(t: float, h: float) -> bool:
        return abs(float(np.polyval((a, b, c), t)) - h) <= tolerance

    # Walk each bound outward from the interior; ground contact is the first
    # point that departs from the flight parabola.
    snapped_takeoff = takeoff
    before = [(t, h) for t, h in points if takeoff - SNAP_WINDOW_SECONDS <= t < takeoff + margin]
    for t, h in sorted(before, reverse=True):
        if follows_parabola(t, h):
            snapped_takeoff = t
        else:
            break

    snapped_landing = landing
    after = [(t, h) for t, h in points if landing - margin < t <= landing + SNAP_WINDOW_SECONDS]
    for t, h in sorted(after):
        if follows_parabola(t, h):
            snapped_landing = t
        else:
            break

    apex = float(-b / (2 * a))
    if not (snapped_takeoff < apex < snapped_landing):
        apex = None
    return snapped_takeoff, snapped_landing, apex


def estimate_flight(series: list[dict], events: list[dict]) -> dict | None:
    """Airtime + estimated air height for a record, or None when the events
    don't describe a flight. Series entries need t/hipHeight/confidence.

    A crash counts as the end of flight when there is no landing event —
    airtime-to-impact is real coaching data. Height then comes from the rise
    to the apex only, since the impact height is unknown."""
    takeoff = _event_time(events, "takeoff")
    landing = _event_time(events, "landing")
    ended_in = "landing"
    if landing is None:
        landing = _event_time(events, "crash")
        ended_in = "crash"
    if takeoff is None or landing is None or landing <= takeoff:
        return None

    points = [
        (float(entry["t"]), float(entry["hipHeight"]))
        for entry in series
        if entry.get("hipHeight") is not None and entry.get("confidence", 0.0) >= MIN_CONFIDENCE
    ]
    snapped_takeoff, snapped_landing, apex = _snap_bounds(points, takeoff, landing)
    if apex is None:
        # Parabola fit unavailable: the AI's peak_air placement still bounds the rise.
        apex = _event_time(events, "peak_air")
        if apex is not None and not (snapped_takeoff < apex < snapped_landing):
            apex = None

    airtime = snapped_landing - snapped_takeoff
    if not (MIN_AIRTIME_SECONDS <= airtime <= MAX_AIRTIME_SECONDS):
        return None

    rise = apex - snapped_takeoff if apex is not None else None
    if ended_in == "crash":
        # The symmetric formula assumes a landing at takeoff height; a crash
        # can hit anywhere, so only the rise is trustworthy.
        method = "rise_time"
        height = 0.5 * GRAVITY * rise * rise if rise is not None else None
    else:
        method = "symmetric"
        height = GRAVITY * airtime * airtime / 8.0
        if rise is not None:
            fall = snapped_landing - apex
            if abs(rise - fall) / airtime > ASYMMETRY_THRESHOLD:
                # Landing height differs from takeoff: only the rise is trustworthy.
                method = "rise_time"
                height = 0.5 * GRAVITY * rise * rise

    return {
        "airtimeSeconds": round(airtime, 2),
        "heightMeters": round(height, 2) if height is not None else None,
        "method": method,
        "endedIn": ended_in,
        "takeoffTime": round(snapped_takeoff, 3),
        "landingTime": round(snapped_landing, 3),
    }
