#!/usr/bin/env bash
# Import every video in simulator-media/ into the booted iPhone simulator's
# Photos library. Files the Simulator rejects (picky about codec/container)
# are re-encoded with ffmpeg and retried automatically.
#
# Usage:  ./scripts/add-media-to-simulator.sh [folder]
#         (folder defaults to simulator-media/ next to this script's repo root)

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
media_dir="${1:-$repo_root/simulator-media}"

if [[ ! -d "$media_dir" ]]; then
  echo "No such folder: $media_dir" >&2
  exit 1
fi

if ! xcrun simctl list devices booted | grep -q "(Booted)"; then
  echo "No booted simulator. Start one first (open -a Simulator), then re-run." >&2
  exit 1
fi

shopt -s nullglob nocaseglob
videos=("$media_dir"/*.{mp4,mov,m4v})
shopt -u nocaseglob

if [[ ${#videos[@]} -eq 0 ]]; then
  echo "No videos (.mp4/.mov/.m4v) found in $media_dir — drop some in and re-run."
  exit 0
fi

added=0 failed=0
for video in "${videos[@]}"; do
  name="$(basename "$video")"
  if xcrun simctl addmedia booted "$video" 2>/dev/null; then
    echo "✓ $name"
    added=$((added + 1))
    continue
  fi

  # Rejected — usually PHPhotosErrorDomain 3302. Clean re-encode and retry.
  if ! command -v ffmpeg >/dev/null; then
    echo "✗ $name (rejected; install ffmpeg to enable automatic re-encode)" >&2
    failed=$((failed + 1))
    continue
  fi

  echo "… $name rejected as-is, re-encoding"
  clean="$(mktemp -d)/${name%.*}.mp4"
  if ffmpeg -loglevel error -y -i "$video" -c:v libx264 -pix_fmt yuv420p \
      -c:a aac -movflags +faststart "$clean" \
      && xcrun simctl addmedia booted "$clean"; then
    echo "✓ $name (re-encoded)"
    added=$((added + 1))
  else
    echo "✗ $name (failed even after re-encode)" >&2
    failed=$((failed + 1))
  fi
  rm -rf "$(dirname "$clean")"
done

echo "Done: $added added, $failed failed."
