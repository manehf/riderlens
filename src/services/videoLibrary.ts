import * as FileSystem from "expo-file-system/legacy";

import type { ClipReview } from "../types/domain";

const VIDEO_LIBRARY_PATH = "riderlens/videos/";

function getVideoLibraryDirectory(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error("RiderLens video library is unavailable on this device.");
  }

  return `${FileSystem.documentDirectory}${VIDEO_LIBRARY_PATH}`;
}

function isStoredVideoUri(uri: string): boolean {
  return uri.startsWith(getVideoLibraryDirectory());
}

function getExtension(uri: string): string {
  const cleanUri = uri.split("?")[0] ?? uri;
  const fileName = cleanUri.split("/").pop() ?? "";
  const match = fileName.match(/\.[A-Za-z0-9]+$/);
  return match?.[0].toLowerCase() ?? ".mp4";
}

function createStoredVideoUri(sourceUri: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${getVideoLibraryDirectory()}clip-${id}${getExtension(sourceUri)}`;
}

async function ensureVideoLibraryDirectory() {
  await FileSystem.makeDirectoryAsync(getVideoLibraryDirectory(), { intermediates: true });
}

export async function persistVideoToLibrary(sourceUri: string): Promise<string> {
  if (isStoredVideoUri(sourceUri)) {
    return sourceUri;
  }

  await ensureVideoLibraryDirectory();

  const targetUri = createStoredVideoUri(sourceUri);
  await FileSystem.copyAsync({
    from: sourceUri,
    to: targetUri
  });

  return targetUri;
}

export async function persistClipReviewVideo(clip: ClipReview): Promise<ClipReview> {
  const storedUri = await persistVideoToLibrary(clip.uri);
  return {
    ...clip,
    uri: storedUri
  };
}

/** Remove a source video copy from the app library. Only touches files inside
 * the library directory — never the rider's Photos or arbitrary URIs. */
export async function deleteLibraryVideo(uri: string): Promise<void> {
  if (!isStoredVideoUri(uri)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best effort: a missing file is already the desired state.
  }
}
