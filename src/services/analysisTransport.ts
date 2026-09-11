import type { AnalysisTransport } from "./analysisTransport.types";

// Web fallback. Metro selects the .ios.ts or .android.ts adapter on mobile.
export function getAnalysisTransport(): AnalysisTransport | null { return null; }
export function nativeAnalysisSubmissionsEnabled(): boolean { return false; }
export function watchAnalysisBackground(_abort: () => void): () => void { return () => undefined; }
