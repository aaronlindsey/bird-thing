#!/usr/bin/env bash
# Polls BirdNET-Go's local API for new detections and forwards them
# to the Cloudflare Worker webhook. Designed to run every minute via cron.

set -euo pipefail

BIRDNET_API="http://localhost:8080/api/v2/detections"
WEBHOOK_URL="https://birds.lindsey.fyi/api/detections"
STATE_FILE="${HOME}/.local/state/bird-poller/last-id"
TOKEN_FILE="${HOME}/.local/state/bird-poller/webhook-token"
LIMIT=20

log_err() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*" >&2; }

# Ensure state directory exists
mkdir -p "$(dirname "$STATE_FILE")"

# Read last-seen ID (0 if first run)
last_id=0
if [[ -f "$STATE_FILE" ]]; then
  last_id=$(<"$STATE_FILE")
fi

# Read webhook token
if [[ ! -f "$TOKEN_FILE" ]]; then
  log_err "ERROR: Missing token file at $TOKEN_FILE"
  log_err "Run: echo 'YOUR_TOKEN' > $TOKEN_FILE && chmod 600 $TOKEN_FILE"
  exit 1
fi
token=$(<"$TOKEN_FILE")

# Fetch recent detections (sorted by newest first by default)
# Append HTTP status code as last 3 chars of output
raw=$(curl -s -w '%{http_code}' "${BIRDNET_API}?limit=${LIMIT}" 2>/dev/null) || {
  log_err "ERROR: Failed to reach BirdNET-Go API"
  exit 1
}
api_status="${raw: -3}"
response="${raw:0:${#raw}-3}"
if [[ "$api_status" != "200" ]]; then
  log_err "ERROR: BirdNET-Go API returned HTTP $api_status: $response"
  exit 1
fi

# Extract detections newer than last_id, reverse to process oldest first
# Uses jq to filter and transform
detections=$(echo "$response" | jq -c --argjson last "$last_id" '
  [.data[] | select(.id > $last)] | sort_by(.id) | .[]
')

if [[ -z "$detections" ]]; then
  exit 0
fi

max_id=$last_id
failures=0

while IFS= read -r det; do
  id=$(echo "$det" | jq -r '.id')
  common_name=$(echo "$det" | jq -r '.commonName')
  scientific_name=$(echo "$det" | jq -r '.scientificName')
  confidence=$(echo "$det" | jq -r '.confidence')
  timestamp=$(echo "$det" | jq -r '.timestamp')
  is_new_species=$(echo "$det" | jq '.isNewSpecies // false')

  payload=$(jq -n \
    --arg cn "$common_name" \
    --arg sn "$scientific_name" \
    --argjson co "$confidence" \
    --arg ts "$timestamp" \
    --argjson ins "$is_new_species" \
    '{common_name: $cn, scientific_name: $sn, confidence: $co, detected_at: $ts, is_new_species: $ins}')

  status=$(curl -sf -o /dev/null -w '%{http_code}' \
    -X POST "$WEBHOOK_URL" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null) || status=0

  if [[ "$status" == "201" ]]; then
    if (( id > max_id )); then
      max_id=$id
    fi
  else
    log_err "WARN: Failed to post detection id=$id species=\"$common_name\" status=$status"
    ((failures++))
  fi
done <<< "$detections"

# Only advance the cursor past successfully posted detections
if (( max_id > last_id )); then
  echo "$max_id" > "$STATE_FILE"
fi

if (( failures > 0 )); then
  exit 1
fi
