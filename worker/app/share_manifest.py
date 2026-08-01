"""Versioned public-share metadata shared by the worker and future app clients."""

from __future__ import annotations

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


ShareSkillType = Literal["regular_jump", "bunnyhop", "manual", "wheelie", "drop"]
ShareEventName = Literal["approach", "compression", "takeoff", "peak_air", "landing", "crash"]


class ShareAssetsV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clean: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    skeleton: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    )
    poster: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    detail: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    )
    playback: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class ShareFlightV1(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    airtimeSeconds: float = Field(gt=0)
    heightMeters: float | None = Field(default=None, ge=0)
    method: Literal["symmetric", "rise_time"]
    endedIn: Literal["landing", "crash"]
    takeoffTime: float = Field(ge=0)
    landingTime: float = Field(ge=0)

    @model_validator(mode="after")
    def landing_follows_takeoff(self) -> Self:
        if self.landingTime <= self.takeoffTime:
            raise ValueError("landingTime must be after takeoffTime")
        return self


class ShareEventV1(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    name: ShareEventName
    time_seconds: float = Field(ge=0)
    why: str = Field(max_length=500)


class ShareDetailV1(BaseModel):
    """Minimum shape required for an imported record's heavy detail file."""

    model_config = ConfigDict(extra="allow")

    series: list[dict]
    filmstrip: list[dict]


class ShareManifestV1(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schemaVersion: Literal[1] = 1
    shareId: str = Field(min_length=8, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    createdAt: str = Field(min_length=1)
    skillType: ShareSkillType = "regular_jump"
    durationSeconds: float = Field(gt=0)
    sharedByName: str | None = Field(default=None, max_length=40)
    flight: ShareFlightV1 | None = None
    events: list[ShareEventV1] = Field(default_factory=list, max_length=24)
    assets: ShareAssetsV1

    # Kept only while released clients still submit the original share form.
    airtimeSeconds: float | None = Field(default=None, ge=0)
    heightMeters: float | None = Field(default=None, ge=0)


class ShareControlV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    shareId: str = Field(min_length=8, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    createdAt: str = Field(min_length=1)
    deleteTokenHash: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")
