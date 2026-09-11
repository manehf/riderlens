/** Native receipts remain authoritative until the record index durably consumes them. */
export type TransferSnapshot = {
  attemptId: string;
  transferId: string;
  state: "preparing" | "running" | "cancelling" | "terminal";
  bytesSent: number;
  bytesExpected: number;
  createdAt: number;
  completedAt?: number;
  status?: number;
  body?: string;
  retryAfter?: string;
  errorDomain?: string;
  errorCode?: number;
  errorMessage?: string;
};

export type TransferInput = {
  attemptId: string;
  url: string;
  sourceUri?: string;
  fields: Record<string, string>;
  headers: Record<string, string>;
};

export interface AnalysisTransport {
  ensureUpload(input: TransferInput): Promise<TransferSnapshot>;
  reconcile(): Promise<TransferSnapshot[]>;
  resume(transferId: string): Promise<TransferSnapshot>;
  cancel(transferId: string): Promise<TransferSnapshot>;
  acknowledge(transferId: string): Promise<void>;
}
