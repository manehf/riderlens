import type { JumpRecord } from "../types/domain";

export function analysisRequestId(record: JumpRecord): string {
  if (record.analysisAttemptId) return record.analysisAttemptId;
  return [record.id, Math.round(record.windowStart * 1000), Math.round(record.windowEnd * 1000), record.rotateDegrees ?? 0].join("-");
}

export function isCurrentAnalysisAttempt(record: JumpRecord | undefined, requestId: string): boolean {
  return Boolean(record && analysisRequestId(record) === requestId);
}

/** Retry-After supports both delta seconds and an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function analysisRetryDelay(attempt: number, retryAfterMs?: number, random = Math.random()): number {
  const exponential = Math.min(300_000, 30_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 4));
  // Never retry before the server's minimum; jitter spreads synchronized phones.
  return Math.max(exponential, retryAfterMs ?? 0) + Math.floor(random * 5000);
}

/** All initial, manual and automatic requests share this FIFO. */
export class SerialAnalysisQueue {
  private tail: Promise<void> = Promise.resolve();
  private ids = new Set<string>();

  enqueue(id: string, task: () => Promise<void>): Promise<void> {
    if (this.ids.has(id)) return this.tail;
    this.ids.add(id);
    const next = this.tail.then(task).finally(() => this.ids.delete(id));
    this.tail = next.catch(() => undefined);
    return next;
  }
}
