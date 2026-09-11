import { AppState } from "react-native";
import type { AnalysisTransport } from "./analysisTransport.types";

// Android keeps foreground uploads; status and result reads follow app visibility.
export function getAnalysisTransport(): AnalysisTransport | null { return null; }
export function nativeAnalysisSubmissionsEnabled(): boolean { return false; }
export function watchAnalysisBackground(abort: () => void): () => void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") abort();
  });
  if (AppState.currentState !== "active") abort();
  return () => subscription.remove();
}
