# Backyard Bird Sound Monitor

A Raspberry Pi running [BirdNET-Go](https://github.com/tphakala/birdnet-go) listens to backyard audio 24/7, identifies bird species using machine learning, and publishes detections to a public webpage at [birds.lindsey.fyi](https://birds.lindsey.fyi). No audio ever leaves the Pi — only species names, confidence scores, and timestamps.

## Architecture

```
Raspberry Pi 3B+                              Cloudflare
┌──────────────────────────┐                   ┌──────────────────────────┐
│  USB mic → BirdNET-Go    │                   │  Worker (API)            │
│    ↓                     │                   │    POST /api/detections  │
│  Local SQLite + Web UI   │   curl (1/min)    │    GET  /api/detections  │
│    ↓                     │ ───────────────►  │    ↓                     │
│  poll-detections.sh      │   bearer token    │  D1 database             │
│  (cron, every minute)    │                   │    ↓                     │
└──────────────────────────┘                   │  Static frontend         │
                                               │    ↓                     │
                                               │  Wikipedia images        │
                                               └──────────────────────────┘
```

- **Pi:** Captures audio, runs BirdNET-Go inference, stores detections locally.
- **Polling script:** Cron job queries BirdNET-Go's local API every minute, forwards new detections to the Cloudflare Worker via authenticated POST.
- **Cloudflare Worker:** Receives detections, stores them in D1 (SQLite), serves a GET endpoint with the last 24 hours of detections grouped by species.
- **Frontend:** Static HTML/CSS/JS served by the same Worker. Fetches detections every 5 minutes, looks up bird photos from Wikipedia, displays a responsive card grid.

### Why polling instead of webhooks

BirdNET-Go has a built-in webhook system, but it only sends notifications for **new species** detections (first sighting), not every detection. This is hardcoded behavior. The nightly builds also have event bus bugs that cause webhooks to fire unreliably. Polling the local REST API is simple and reliable. See [POLLING_SETUP.md](POLLING_SETUP.md) for investigation details.

## Project structure

```
bird-thing/
├── wrangler.toml              # Worker + D1 + assets config
├── package.json               # wrangler dev dependency
├── schema.sql                 # D1 database schema
├── worker/
│   └── index.js               # Cloudflare Worker (API routes)
├── frontend/
│   ├── index.html             # Page structure
│   ├── style.css              # Responsive card grid, dark mode
│   └── app.js                 # Fetch, cache, render logic
├── poller/
│   └── poll-detections.sh     # Detection polling script (runs on Pi)
├── PROJECT_PLAN.md            # Full project plan (all phases)
├── PLAN.md                    # Phase 3B implementation plan
├── SETUP_LOG.md               # Pi setup log (BirdNET-Go, Docker, config)
└── POLLING_SETUP.md           # Polling script setup and investigation notes
```

## Deploying the Cloudflare Worker

### Prerequisites

- Node.js 18+
- A Cloudflare account
- A domain configured in Cloudflare DNS

### Steps

```bash
# Install dependencies
npm install

# Authenticate with Cloudflare
npx wrangler login

# Create the D1 database (first time only)
npm run db:create
# Copy the database_id from the output into wrangler.toml

# Initialize the database schema
npm run db:init

# Set the webhook authentication token
npx wrangler secret put WEBHOOK_TOKEN
# Enter a strong random token — the Pi poller will use this same token

# Deploy
npm run deploy

# Configure your custom domain in the Cloudflare dashboard if needed
```

### Local development

```bash
# Initialize local D1 database
npm run db:init:local

# Start local dev server
npm run dev
# Opens at http://localhost:8787

# Test the webhook
curl -X POST http://localhost:8787/api/detections \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "common_name": "American Robin",
    "scientific_name": "Turdus migratorius",
    "confidence": 0.92,
    "detected_at": "2026-03-24T10:30:00Z"
  }'
# Should return 201

# Verify it appears
curl http://localhost:8787/api/detections
```

## Setting up the Raspberry Pi

### Hardware

- Raspberry Pi 3B+ (or newer)
- SanDisk High Endurance 64GB microSD card
- USB microphone (e.g., Boya BY-LM40)
- Quality 5V 2.5A power supply

### 1. Flash the OS

Use Raspberry Pi Imager to flash **Raspberry Pi OS Lite (64-bit), Bookworm**. Configure Wi-Fi and enable SSH in the imager settings before flashing.

### 2. Install Docker and BirdNET-Go

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for group change to take effect

# Pull BirdNET-Go
docker pull ghcr.io/tphakala/birdnet-go:nightly

# Create application directories
mkdir -p ~/birdnet-go-app/config ~/birdnet-go-app/data/clips
```

### 3. Configure BirdNET-Go

Download the default config and edit it:

```bash
# Download default config
docker run --rm ghcr.io/tphakala/birdnet-go:nightly \
  cat /home/birdnet/.config/birdnet-go/config.yaml \
  > ~/birdnet-go-app/config/config.yaml
```

Edit `~/birdnet-go-app/config/config.yaml` — key settings to change:

| Setting | Set to | Reason |
|---------|--------|--------|
| `birdnet.overlap` | `0.0` | Save CPU on Pi 3B+ |
| `birdnet.latitude` | Your latitude | Species range filter |
| `birdnet.longitude` | Your longitude | Species range filter |
| `birdnet.locationconfigured` | `true` | Enable range filter |
| `realtime.audio.source` | Your USB mic ALSA ID | Use `arecord -l` to find it |
| `realtime.audio.export.path` | `/data/clips/` | Docker volume path |

### 4. Reduce GPU memory

Add this to `/boot/firmware/config.txt` under `[all]` to free ~12MB of RAM for BirdNET-Go:

```
gpu_mem=64
```

Reboot for this to take effect.

### 5. Create the systemd service

Create `/etc/systemd/system/birdnet-go.service` (replace `USER` with your username):

```ini
[Unit]
Description=BirdNET-Go
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=5

# Disable WiFi power saving to prevent connection drops
ExecStartPre=/bin/sh -c 'for iface in /sys/class/net/wl*; do [ -e "$iface" ] && /sbin/iw dev $(basename "$iface") set power_save off 2>/dev/null || true; done'

# Create tmpfs for HLS streaming segments
ExecStartPre=/bin/sh -c 'mkdir -p /home/USER/birdnet-go-app/config/hls && mount -t tmpfs -o size=50m tmpfs /home/USER/birdnet-go-app/config/hls 2>/dev/null || true'

# Stop and remove existing container if it exists
ExecStartPre=/usr/bin/docker rm -f birdnet-go 2>/dev/null || true

ExecStart=/usr/bin/docker run --rm --name birdnet-go \
    -p 8080:8080 \
    --env TZ=America/Los_Angeles \
    --env BIRDNET_UID=1000 \
    --env BIRDNET_GID=1000 \
    --device /dev/snd \
    -v /home/USER/birdnet-go-app/config:/config \
    -v /home/USER/birdnet-go-app/data:/data \
    -v /sys/class/thermal:/sys/class/thermal \
    ghcr.io/tphakala/birdnet-go:nightly

ExecStop=/usr/bin/docker stop birdnet-go

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now birdnet-go
```

### 6. Verify BirdNET-Go is running

```bash
# Check service status
sudo systemctl status birdnet-go

# Check the web dashboard
curl -s http://localhost:8080/api/v2/detections?limit=1
```

The web dashboard is available at `http://<pi-ip>:8080`.

### 7. Install the polling script

```bash
# Install jq (required)
sudo apt-get install -y jq

# Copy the polling script
cp poller/poll-detections.sh ~/poll-detections.sh
chmod +x ~/poll-detections.sh

# Set up state directory and webhook token
mkdir -p ~/.local/state/bird-poller
echo 'YOUR_WEBHOOK_TOKEN' > ~/.local/state/bird-poller/webhook-token
chmod 600 ~/.local/state/bird-poller/webhook-token

# Seed the cursor to the latest detection (only forwards new detections)
curl -sf 'http://localhost:8080/api/v2/detections?limit=1' \
  | jq -r '.data[0].id' \
  > ~/.local/state/bird-poller/last-id

# Test the script
bash ~/poll-detections.sh && echo "OK"

# Install the cron job (runs every minute)
(crontab -l 2>/dev/null; echo '* * * * * /home/'"$USER"'/poll-detections.sh 2>> /home/'"$USER"'/.local/state/bird-poller/errors.log') | crontab -
```

### Polling script maintenance

```bash
# Check for errors
cat ~/.local/state/bird-poller/errors.log

# See current cursor position
cat ~/.local/state/bird-poller/last-id

# Backfill: lower the ID to re-post older detections
echo '1000' > ~/.local/state/bird-poller/last-id

# Pause polling
crontab -e  # comment out the line

# Update webhook token
echo 'NEW_TOKEN' > ~/.local/state/bird-poller/webhook-token
```

## Troubleshooting

### Cloudflare Worker logs

```bash
# Tail live Worker logs (shows incoming requests, console.log output, errors)
npx wrangler tail
```

### BirdNET-Go logs on the Pi

Logs are written inside the container to `/data/logs/`. Each module has its own file:

```bash
# Detection activity (species detected, confidence, approval/rejection)
sudo docker exec birdnet-go tail -f /data/logs/actions.log

# Notification/webhook activity
sudo docker exec birdnet-go tail -f /data/logs/notifications.log

# Audio capture (device selection, errors)
sudo docker exec birdnet-go tail -f /data/logs/audio.log

# All logs at once
sudo docker logs -f birdnet-go
```

### Polling script logs

```bash
# Errors from the cron job
cat ~/.local/state/bird-poller/errors.log

# Current cursor (last successfully posted detection ID)
cat ~/.local/state/bird-poller/last-id

# Run manually to see output immediately
bash ~/poll-detections.sh
```

## Reference links

- [BirdNET-Go GitHub](https://github.com/tphakala/birdnet-go)
- [BirdNET-Go Guide (Wiki)](https://github.com/tphakala/birdnet-go/wiki/BirdNET%E2%80%90Go-Guide)
- [BirdNET-Go Recommended Hardware](https://github.com/tphakala/birdnet-go/wiki/Recommended-Hardware)
