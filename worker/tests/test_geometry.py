"""Geometry math tests driven by the shared fixture file.

The same fixtures run against src/services/analysis.ts (vitest), so the
duplicated TypeScript and Python implementations cannot drift apart.
"""

import json
from pathlib import Path

import pytest

from app.main import (
    FrameLine,
    FramePoint,
    angle_between_lines,
    clamp,
    joint_angle,
    line_angle,
    normalize_angle,
)

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "geometry.json").read_text()
)


def to_point(raw: dict) -> FramePoint:
    return FramePoint(x=raw["x"], y=raw["y"])


def to_line(raw: dict) -> FrameLine:
    return FrameLine(start=to_point(raw["start"]), end=to_point(raw["end"]))


@pytest.mark.parametrize("case", FIXTURES["lineAngle"], ids=lambda case: case["name"])
def test_line_angle(case):
    assert line_angle(to_line(case["line"])) == pytest.approx(case["expected"], abs=1e-6)


@pytest.mark.parametrize("case", FIXTURES["angleBetweenLines"], ids=lambda case: case["name"])
def test_angle_between_lines(case):
    assert angle_between_lines(to_line(case["first"]), to_line(case["second"])) == pytest.approx(
        case["expected"], abs=1e-6
    )


@pytest.mark.parametrize("case", FIXTURES["jointAngle"], ids=lambda case: case["name"])
def test_joint_angle(case):
    # acos is numerically noisy at the 0/180 boundaries; the app rounds to whole degrees.
    result = joint_angle(to_point(case["first"]), to_point(case["joint"]), to_point(case["second"]))
    assert result == pytest.approx(case["expected"], abs=1e-3)


@pytest.mark.parametrize("case", FIXTURES["normalizeAngle"], ids=lambda case: str(case["input"]))
def test_normalize_angle(case):
    assert normalize_angle(case["input"]) == pytest.approx(case["expected"], abs=1e-9)


@pytest.mark.parametrize("case", FIXTURES["clamp"], ids=lambda case: str(case["value"]))
def test_clamp(case):
    assert clamp(case["value"], case["min"], case["max"]) == case["expected"]
