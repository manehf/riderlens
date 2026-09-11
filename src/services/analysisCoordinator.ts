import { analysisRequestId } from "./analysisRetry";
import type { AnalysisTransport, TransferSnapshot } from "./analysisTransport.types";
import type { JumpRecord } from "../types/domain";

export function transferPhase(snapshot: TransferSnapshot): JumpRecord["analysisPhase"] {
  if (snapshot.state === "preparing") return "preparing";
  if (snapshot.state === "cancelling") return "cancelling";
  return snapshot.bytesExpected > 0 && snapshot.bytesSent >= snapshot.bytesExpected
    ? "awaiting_acceptance" : "uploading";
}

/** Call only after persisting record deletion/replacement. Re-read ownership after
 * awaits: a user can remove a record while session enumeration is in flight. */
export async function reconcileAnalysisTransfers(
  transport: AnalysisTransport,
  getRecords: () => readonly JumpRecord[],
  persistRecords: () => Promise<void>,
  canResume: () => boolean = () => true
): Promise<TransferSnapshot[]> {
  const snapshots = await transport.reconcile();
  const current: TransferSnapshot[] = [];
  for (let snapshot of snapshots) {
    const owns = () => getRecords().some((record) => record.status !== "ready" && analysisRequestId(record) === snapshot.attemptId);
    if (owns() && snapshot.state === "preparing") {
      await persistRecords();
      if (owns() && canResume()) snapshot = await transport.resume(snapshot.transferId);
    }
    if (owns()) {
      current.push(snapshot);
      continue;
    }
    // A crash between changing ownership and cancel() is resolved here. Persist
    // again before destructive cleanup so an in-flight UI mutation is durable.
    await persistRecords();
    if (owns()) { current.push(snapshot); continue; }
    if (snapshot.state !== "terminal") snapshot = await transport.cancel(snapshot.transferId);
    if (snapshot.state === "terminal") await transport.acknowledge(snapshot.transferId);
    else current.push(snapshot); // Still owns its files / global upload slot.
  }
  return current;
}

/** Persist first; a failed write must leave the native receipt available. */
export async function consumeTransferReceipt(
  transport: AnalysisTransport | null,
  snapshot: TransferSnapshot | undefined,
  persist: () => Promise<void>
): Promise<void> {
  await persist();
  if (transport && snapshot?.state === "terminal") await transport.acknowledge(snapshot.transferId);
}

export function transferDiagnostics(snapshot?: TransferSnapshot): Record<string, unknown> {
  if (!snapshot) return {};
  // Deliberately exclude the body, request headers, source path and error text.
  return {
    requestId: snapshot.attemptId, transferId: snapshot.transferId,
    transferState: snapshot.state, bytesSent: snapshot.bytesSent, bytesExpected: snapshot.bytesExpected,
    transferStartedAt: snapshot.createdAt, transferCompletedAt: snapshot.completedAt,
    httpStatus: snapshot.status, nativeErrorDomain: snapshot.errorDomain, nativeErrorCode: snapshot.errorCode
  };
}
