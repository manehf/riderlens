import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false
      }
    })
  : null;

export const storageBuckets = {
  rawVideos: "raw-videos",
  keyFrames: "key-frames",
  annotatedVideos: "annotated-videos",
  sharedReports: "shared-reports"
} as const;

export type SupabaseMode = "configured" | "demo";

export function getSupabaseMode(): SupabaseMode {
  return isSupabaseConfigured ? "configured" : "demo";
}
