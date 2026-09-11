import type { AnalysisTransport } from "./analysisTransport.types";

// Android/web retain their existing submission transport. Metro selects .ios.ts.
export function getAnalysisTransport(): AnalysisTransport | null { return null; }
export function nativeAnalysisSubmissionsEnabled(): boolean { return false; }
export function watchAnalysisBackground(_abort: () => void): () => void { return () => undefined; }
