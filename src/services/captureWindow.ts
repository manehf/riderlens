export const MIN_ANALYSIS_WINDOW_SECONDS = 0.5;
export const MAX_ANALYSIS_WINDOW_SECONDS = 8;

export function shouldLoopSelection(isPlaying: boolean, currentTime: number, endTime: number) {
  return isPlaying && currentTime >= endTime - 0.03;
}

export function fitAnalysisWindow(startSeconds: number, endSeconds: number, durationSeconds: number) {
  const duration = Math.max(MIN_ANALYSIS_WINDOW_SECONDS, durationSeconds);
  let start = Math.max(0, Math.min(startSeconds, duration - MIN_ANALYSIS_WINDOW_SECONDS));
  let end = Math.max(start + MIN_ANALYSIS_WINDOW_SECONDS, Math.min(endSeconds, duration));
  if (end - start <= MAX_ANALYSIS_WINDOW_SECONDS) return { start, end };

  const center = (start + end) / 2;
  start = Math.max(0, Math.min(center - MAX_ANALYSIS_WINDOW_SECONDS / 2, duration - MAX_ANALYSIS_WINDOW_SECONDS));
  end = Math.min(duration, start + MAX_ANALYSIS_WINDOW_SECONDS);
  return { start, end };
}

export function updateAnalysisWindow(
  current: { start: number; end: number },
  updates: { start?: number; end?: number },
  durationSeconds: number
) {
  const duration = Math.max(MIN_ANALYSIS_WINDOW_SECONDS, durationSeconds);
  const changesStart = updates.start !== undefined;
  const changesEnd = updates.end !== undefined;

  if (changesStart && !changesEnd) {
    const end = Math.max(MIN_ANALYSIS_WINDOW_SECONDS, Math.min(current.end, duration));
    const minimumStart = Math.max(0, end - MAX_ANALYSIS_WINDOW_SECONDS);
    const maximumStart = end - MIN_ANALYSIS_WINDOW_SECONDS;
    const start = Math.max(minimumStart, Math.min(updates.start!, maximumStart));
    return { start, end };
  }

  if (changesEnd && !changesStart) {
    const start = Math.max(0, Math.min(current.start, duration - MIN_ANALYSIS_WINDOW_SECONDS));
    const minimumEnd = start + MIN_ANALYSIS_WINDOW_SECONDS;
    const maximumEnd = Math.min(duration, start + MAX_ANALYSIS_WINDOW_SECONDS);
    const end = Math.max(minimumEnd, Math.min(updates.end!, maximumEnd));
    return { start, end };
  }

  return fitAnalysisWindow(
    updates.start ?? current.start,
    updates.end ?? current.end,
    duration
  );
}
