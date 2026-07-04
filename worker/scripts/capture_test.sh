#!/usr/bin/env bash
# Drive the capture flow end-to-end from the terminal: propose a window, create the
# record, and save the trimmed moment clip next to you.
#
# Usage:
#   worker/scripts/capture_test.sh <video> [worker_url]
#
# Example:
#   worker/scripts/capture_test.sh clips/regular_jump/fail/jump_fail.mp4
set -euo pipefail

CLIP="${1:?usage: capture_test.sh <video> [worker_url]}"
WORKER_URL="${2:-http://127.0.0.1:8000}"

if [ ! -f "$CLIP" ]; then
  echo "error: clip not found: $CLIP" >&2
  exit 1
fi

echo "1) /capture/analyze — uploading and proposing a window..."
ANALYZE=$(curl -sS --fail-with-body -X POST "$WORKER_URL/capture/analyze" -F "video=@$CLIP;type=video/mp4")
echo "$ANALYZE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"   uploadId: {data['uploadId']}\")
print(f\"   duration: {data['durationSeconds']}s | aiAvailable: {data['aiAvailable']}\")
if data['window']:
    print(f\"   window:   {data['window']['start']}s -> {data['window']['end']}s ({data.get('eventType')})\")
else:
    print(f\"   window:   none ({data.get('aiReason') or 'manual trim required'})\")
"

UPLOAD_ID=$(echo "$ANALYZE" | python3 -c "import json,sys; print(json.load(sys.stdin)['uploadId'])")
START=$(echo "$ANALYZE" | python3 -c "import json,sys; w=json.load(sys.stdin)['window']; print(w['start'] if w else 0)")
END=$(echo "$ANALYZE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
w = data['window']
print(w['end'] if w else min(4.0, data['durationSeconds']))
")
EVENTS=$(echo "$ANALYZE" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['events']))")

echo "2) /capture/record — cropping ${START}s -> ${END}s and measuring..."
OUT="moment-$(basename "${CLIP%.*}").mp4"
curl -sS --fail-with-body -X POST "$WORKER_URL/capture/record" \
  -F "upload_id=$UPLOAD_ID" \
  -F "start_seconds=$START" \
  -F "end_seconds=$END" \
  -F "events_json=$EVENTS" \
  | python3 -c "
import base64, json, sys
data = json.load(sys.stdin)
clip = base64.b64decode(data['clip'].split(',', 1)[1])
open('$OUT', 'wb').write(clip)
print(f\"   clip:      $OUT ({len(clip) // 1024}KB)\")
print(f\"   window:    {data['window']}\")
print(f\"   metrics:   {len(data['metrics'])} key frames | series: {len(data['series'])} rows | filmstrip: {len(data['filmstrip'])} thumbs\")
"
echo "3) open $OUT to watch the trimmed moment."
