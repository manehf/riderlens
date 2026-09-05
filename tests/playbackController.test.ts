import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlaybackController } from "../src/services/playbackController";

function setup() {
  const target = { play: vi.fn(), pause: vi.fn(), currentTime: 0, playbackRate: 1 };
  const onPlayingChange = vi.fn();
  const playback = createPlaybackController(target, onPlayingChange);
  const toggle = () => (playback.isPlaying ? playback.pause() : playback.play());
  return { target, onPlayingChange, playback, toggle };
}

describe("viewer playback intent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts paused without setting a native rate or starting playback", () => {
    const { playback, target, onPlayingChange } = setup();
    expect(playback.isPlaying).toBe(false);
    expect(playback.canSyncTime).toBe(false);
    expect(target.play).not.toHaveBeenCalled();
    expect(onPlayingChange).not.toHaveBeenCalled();
  });

  it("pauses on a second tap before any native playing event arrives", () => {
    const { playback, target, toggle, onPlayingChange } = setup();
    toggle();
    toggle();
    expect(playback.isPlaying).toBe(false);
    expect(target.play).toHaveBeenCalledTimes(1);
    expect(target.pause).toHaveBeenCalledTimes(1);
    expect(onPlayingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("does not mistake buffering for a user pause", () => {
    const { playback, target, toggle } = setup();
    toggle();
    playback.onNativePlayingChange(false);
    expect(playback.isPlaying).toBe(true);
    toggle();
    expect(target.play).toHaveBeenCalledTimes(1);
    expect(target.pause).toHaveBeenCalledTimes(1);
  });

  it("rejects a delayed loop callback after pause, even after the seek window", () => {
    const { playback, target } = setup();
    playback.play();
    playback.pause();
    vi.advanceTimersByTime(1000);
    target.currentTime = 3;
    expect(playback.canSyncTime).toBe(false);
    expect(playback.restartLoop()).toBe(false);
    expect(target.currentTime).toBe(3);
    expect(target.play).toHaveBeenCalledTimes(1);
  });

  it("keeps the pause button active throughout a loop's native pause event", () => {
    const { playback, target, toggle, onPlayingChange } = setup();
    playback.play();
    vi.advanceTimersByTime(400);
    target.currentTime = 3;
    expect(playback.restartLoop()).toBe(true);
    expect(target.currentTime).toBe(0);
    playback.onNativePlayingChange(false);
    expect(playback.isPlaying).toBe(true);
    expect(onPlayingChange.mock.calls).toEqual([[true]]);
    toggle();
    expect(playback.isPlaying).toBe(false);
    expect(target.play).toHaveBeenCalledTimes(2);
  });

  it("suppresses timeUpdate echoes while a loop seek settles", () => {
    const { playback, target } = setup();
    playback.play();
    vi.advanceTimersByTime(400);
    expect(playback.restartLoop()).toBe(true);
    expect(playback.canSyncTime).toBe(false);
    expect(target.play).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(400);
    expect(playback.canSyncTime).toBe(true);
  });

  it("loops a genuine clip end even when resuming near the last frame", () => {
    const { playback, target } = setup();
    playback.seek(2.9);
    playback.play();
    vi.advanceTimersByTime(100);
    expect(playback.canSyncTime).toBe(false);
    expect(playback.restartLoop()).toBe(true);
    expect(target.currentTime).toBe(0);
    expect(target.play).toHaveBeenCalledTimes(2);
  });

  it("reasserts pause if a delayed native event reports playing", () => {
    const { playback, target } = setup();
    playback.play();
    playback.pause();
    playback.onNativePlayingChange(true);
    expect(playback.isPlaying).toBe(false);
    expect(target.pause).toHaveBeenCalledTimes(2);
    expect(target.play).toHaveBeenCalledTimes(1);
  });

  it("pauses before a manual seek and ignores subsequent native playback echoes", () => {
    const { playback, target } = setup();
    playback.play();
    playback.seek(1.25);
    expect(playback.isPlaying).toBe(false);
    expect(target.currentTime).toBe(1.25);
    expect(target.pause).toHaveBeenCalledTimes(1);
    playback.onNativePlayingChange(true);
    vi.advanceTimersByTime(400);
    expect(playback.canSyncTime).toBe(false);
    expect(playback.restartLoop()).toBe(false);
  });

  it("defers speed changes while paused, including on initial setup", () => {
    const { playback, target } = setup();
    const rateSetter = vi.fn();
    Object.defineProperty(target, "playbackRate", { set: rateSetter });
    playback.setSpeed(1);
    playback.setSpeed(0.5);
    expect(rateSetter).not.toHaveBeenCalled();
    playback.play();
    expect(rateSetter).toHaveBeenLastCalledWith(0.5);
    playback.setSpeed(0.25);
    expect(rateSetter).toHaveBeenLastCalledWith(0.25);
    playback.pause();
    rateSetter.mockClear();
    playback.setSpeed(1);
    expect(rateSetter).not.toHaveBeenCalled();
  });

  it("retains the latest play intent when an older pause event arrives", () => {
    const { playback, target, toggle } = setup();
    toggle();
    toggle();
    toggle();
    playback.onNativePlayingChange(false);
    expect(playback.isPlaying).toBe(true);
    vi.advanceTimersByTime(400);
    expect(playback.canSyncTime).toBe(true);
    expect(target.play).toHaveBeenCalledTimes(2);
  });

  it("supports legacy frame playback without a native clip", () => {
    const onPlayingChange = vi.fn();
    const playback = createPlaybackController(null, onPlayingChange);
    playback.play();
    expect(playback.isPlaying).toBe(true);
    playback.seek(1);
    expect(playback.isPlaying).toBe(false);
    expect(onPlayingChange.mock.calls).toEqual([[true], [false]]);
  });
});
