type PlaybackTarget = {
  play: () => void;
  pause: () => void;
  currentTime: number;
  playbackRate: number;
};

const SEEK_SETTLE_MS = 350;

/** User intent stays authoritative while native playing/seek events catch up. */
export function createPlaybackController(
  target: PlaybackTarget | null,
  onPlayingChange: (playing: boolean) => void
) {
  let requestedPlaying = false;
  let speed = 1;
  let syncAfter = 0;

  const setPlaying = (playing: boolean) => {
    if (requestedPlaying === playing) return;
    requestedPlaying = playing;
    onPlayingChange(playing);
  };

  const pause = () => {
    // Change intent before issuing native commands: queued timeUpdate events
    // must not restart a loop after the user has paused or begun scrubbing.
    setPlaying(false);
    target?.pause();
  };

  return {
    get isPlaying() {
      return requestedPlaying;
    },
    get canSyncTime() {
      return requestedPlaying && Date.now() >= syncAfter;
    },
    play() {
      setPlaying(true);
      syncAfter = Date.now() + SEEK_SETTLE_MS;
      if (target) {
        target.playbackRate = speed;
        target.play();
      }
    },
    pause,
    seek(time: number) {
      pause();
      syncAfter = Date.now() + SEEK_SETTLE_MS;
      if (target) target.currentTime = time;
    },
    restartLoop() {
      // A genuine playToEnd may arrive inside the settle window when the
      // user resumes close to the end. Only timeUpdate echoes are suppressed.
      if (!requestedPlaying || !target) return false;
      syncAfter = Date.now() + SEEK_SETTLE_MS;
      target.pause();
      target.currentTime = 0;
      if (requestedPlaying) target.play();
      return requestedPlaying;
    },
    setSpeed(value: number) {
      speed = value;
      // expo-video 3.x sets AVPlayer.rate when assigning playbackRate on iOS,
      // which can unpause the video. Defer it until an explicit play request.
      if (requestedPlaying && target) target.playbackRate = value;
    },
    onNativePlayingChange(isPlaying: boolean) {
      if (isPlaying && !requestedPlaying) target?.pause();
      // A false event can be buffering or the pause inside a loop seek. It
      // must not turn the next user tap into another play command.
    }
  };
}
