#!/usr/bin/env bash
# Analyze a reference clip with the local RiderLens worker and pretty-print the response.
#
# Usage:
#   worker/scripts/analyze_clip.sh <video> [trim_start_seconds] [trim_end_seconds] [worker_url]
#
# Examples:
#   worker/scripts/analyze_clip.sh clips/regular_jump/fail/jump_fail.mp4
#   worker/scripts/analyze_clip.sh clips/regular_jump/fail/jump_fail.mp4 1.0 7.5
set -euo pipefail

CLIP="${1:?usage: analyze_clip.sh <video> [trim_start_seconds] [trim_end_seconds] [worker_url]}"
TRIM_START="${2:-0}"
TRIM_END="${3:-}"
WORKER_URL="${4:-http://127.0.0.1:8000}"

if [ ! -f "$CLIP" ]; then
  echo "error: clip not found: $CLIP" >&2
  exit 1
fi

SESSION_ID="clip-$(basename "$CLIP" | tr -c 'A-Za-z0-9' '-')$(date +%s)"

args=(
  -sS --fail-with-body -X POST "$WORKER_URL/analysis/regular-jump"
  -F "video=@$CLIP;type=video/mp4"
  -F "session_id=$SESSION_ID"
  -F "trim_start_seconds=$TRIM_START"
)
if [ -n "$TRIM_END" ]; then
  args+=(-F "trim_end_seconds=$TRIM_END")
fi

curl "${args[@]}" | python3 -m json.tool
