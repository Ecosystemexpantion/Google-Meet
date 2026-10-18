# EEM26 Live Classroom

A professional live class / webinar room for **one presenter and 200+ attendees**,
running in the browser on phones and computers. It is built on
[LiveKit](https://github.com/livekit/livekit), an open-source WebRTC media server
(an SFU). The presenter's screen goes up once and the server sends it out to every
viewer, at the quality each viewer's connection and screen can handle.

| Page | Who | What |
|---|---|---|
| `index.html` | Attendees | Landing page with a countdown. Shows "Join" once the presenter opens the room |
| `room.html` | Attendees | The live classroom |
| `host.html` → `host-room.html` | Presenter | Password sign-in, then the presenter studio |

## Features

**Stage**
- Screen sharing up to 1080p, with optional system/tab audio. *Text & slides* mode (sharp, 15 fps) or *video* mode (30 fps), switchable in ⚙ settings.
- The presenter's camera appears picture-in-picture over the screen share. Microphone and camera can be switched mid-class.
- Simulcast plus adaptive streaming: phones on weak networks get a lighter 360p/720p version automatically, so nobody stalls.
- Full-screen button, live timer, viewer count and a connection-quality indicator.

**Presenter controls (only the presenter has them)**
- **Let anyone share their screen**: People → ⋯ → *Allow screen share*. You can also allow mic, allow camera, or make someone a *co-presenter*.
- **Take off stage**: revokes their permissions on the server and stops their share immediately. *Stop their screen share* and *Mute microphone* also work per person.
- **Chat mode**: *Everyone*, *Questions to me* (attendees message only the presenter, privately) or *Off*.
- **Chat moderation**: delete a message for everyone, pin a message as an announcement, mute one person in chat.
- **Emoji reactions** on or off. **Raise hand** on or off, with a queue, a sound alert and *Lower all hands*.
- **Show / hide the attendee list** from attendees (by default they only see the count).
- **Pinned announcement banner**, e.g. a workbook link.
- **Live polls** (up to 6 options), with results live or revealed when the poll closes.
- **Mute everyone**, **Clear the stage**, **Remove** a participant, **Lock room** (no new joins).
- **End class for everyone**, which shows `CLOSING_MESSAGE` to all attendees. **Download chat transcript.**

**Attendees**
- Join with just a name. No account or app needed.
- Chat with an emoji picker; links are clickable. Late joiners receive the recent chat history and the current poll.
- Floating emoji reactions, raise hand and poll voting.
- If the presenter invites them, a *Share screen* / *Unmute* button appears.
- Auto-reconnect on network drops, a "tap to enable sound" prompt for strict mobile browsers, and a waiting screen that lets them in automatically when the presenter opens the room.

## How it fits together

```
 GitHub Pages (static site)        Supabase Edge Function "livekit"        LiveKit server (SFU)
 index / room / host-room   ──►    - checks host password                ◄── media: 1 up, N down
 js/live/app.js                    - signs join tokens (attendees can't      (LiveKit Cloud or
                                     publish until the presenter allows)       your own VPS)
                                   - presenter-only moderation API
```

Security model:
- Attendees' tokens let them **watch and chat only**. Publishing (mic, camera, screen) is granted live by the presenter through the LiveKit server API, so it cannot be faked from the browser.
- Presenter actions are authorised by the presenter's own signed LiveKit token (`roomAdmin`).
- The host password and LiveKit keys live only in Supabase secrets, never in `config.js`.

## Setup (about 15 minutes)

### 1. Get a LiveKit server

**Option A: LiveKit Cloud (easiest).** Create a project at <https://cloud.livekit.io>. Under *Settings → Keys*, copy the **WebSocket URL** (`wss://….livekit.cloud`), **API key** and **API secret**.
> ⚠️ Plans: the free *Build* tier is capped at about 100 concurrent participants, so for 200 attendees you need *Ship* (about $50/month) or higher. Bandwidth is the main usage cost. Check current numbers on [livekit.io/pricing](https://livekit.io/pricing).

**Option B: self-host (flat cost, no per-minute fees).** Use a VPS with 4+ vCPUs and a 1 Gbps port (Hetzner, DigitalOcean, etc.) and a domain such as `live.yourdomain.com`.
Follow <https://docs.livekit.io/home/self-hosting/vm/>: `docker run --rm -it -v$PWD:/output livekit/generate`
creates a ready-to-run config with automatic TLS. Use LiveKit server **v1.12.0 or newer**. v1.9.x has a bug that hides the presenter's camera when it is turned on during a screen share. Open the TCP/UDP ports listed in that guide.

### 2. Deploy the token function to Supabase

```bash
npm i -g supabase            # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref leqizarzgfpiriknpnxw
supabase secrets set \
  LIVEKIT_URL="wss://YOUR-PROJECT.livekit.cloud" \
  LIVEKIT_API_KEY="APIxxxxxxxx" \
  LIVEKIT_API_SECRET="xxxxxxxxxxxxxxxx" \
  HOST_PASSWORD="choose-a-strong-password" \
  HOST_NAME="Coach Victor" \
  MAX_PARTICIPANTS=300
supabase functions deploy livekit --no-verify-jwt
```

### 3. Publish the site

Merge to `main`. The existing GitHub Pages workflow deploys it. Then open `/host.html`, sign in and click **Start the class**. Attendees use the landing page or `/room.html`.

### Configuration (`config.js`)

| Key | Meaning |
|---|---|
| `BRAND_SHORT`, `CLASS_TITLE`, `PRESENTER_NAME` | Branding in the room (the title can also be changed live) |
| `ROOM_PREFIX` | Room name base. The ISO week is appended, so each week gets a fresh room |
| `LIVEKIT_TOKEN_ENDPOINT` | Leave empty to use the Supabase function; set it if you host the API elsewhere |
| `CLOSING_MESSAGE` | Shown to everyone when the class ends |
| `TRAINING_*` | Countdown schedule on the landing page |

## Tips for a smooth 200-person class
- Presenter: use a wired connection or strong Wi-Fi with at least 5 Mbps upload, in Chrome or Edge on a computer.
- Share a **window or tab** rather than the whole screen, so notifications stay private.
- For slides, keep the default *text & slides* mode. For playing videos, turn on *Optimise screen share for video* in ⚙.
- Use *Questions to me* chat mode during the lesson so the chat stays readable, and open it to *Everyone* for Q&A.
- If you refresh or drop off, the room stays open for 5 minutes. Just come back to `host-room.html`.

## Local development & tests

```bash
npm install
# LiveKit dev server (binary from github.com/livekit/livekit/releases, v1.12+)
livekit-server --dev --bind 127.0.0.1
npm run dev                  # http://localhost:5173, host password "test"
npm run test:e2e             # 26 end-to-end checks in headless Chromium
LK_CLI=lk node dev/load.mjs 200   # 200-viewer load test (needs the LiveKit CLI)
```

Local results: all 26 end-to-end checks pass. With 200 simulated viewers plus a real
phone-sized viewer, the phone viewer played the share at 15 fps (720p, 0–1 dropped
frames), all 200 subscribers had 0% packet loss, and the presenter's people list
drew 200 rows in under 30 ms.
