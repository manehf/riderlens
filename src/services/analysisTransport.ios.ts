import { requireOptionalNativeModule } from "expo";
import { AppState } from "react-native";
import type { AnalysisTransport } from "./analysisTransport.types";

// Older development clients / Expo Go can still use the foreground path. Store
// builds include the local module through Expo autolinking and the config plugin.
const transport = requireOptionalNativeModule<AnalysisTransport>("RiderLensTransfer");
export function getAnalysisTransport(): AnalysisTransport | null { return transport; }
// Build-time comparison switch. Keep the module reachable to drain old tasks.
export function nativeAnalysisSubmissionsEnabled(): boolean {
  return process.env.EXPO_PUBLIC_NATIVE_ANALYSIS_UPLOADS !== "0";
}
/** Status/results are foreground reads; native submission has its own lifetime. */
export function watchAnalysisBackground(abort: () => void): () => void {
  const subscription = AppState.addEventListener("change", (state) => { if (state !== "active") abort(); });
  if (AppState.currentState !== "active") abort();
  return () => subscription.remove();
}
