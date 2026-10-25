# EEM26 Live Classroom

A live class / webinar room for **one presenter and 200+ attendees** that
runs in the browser on phones and computers, and **costs nothing to run**:

| Piece | Service | Free allowance |
|---|---|---|
| Web pages | GitHub Pages | Free |
| Video, audio, chat delivery | [Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/) | **1,000 GB/month** of viewer traffic, no credit card |
| The one small server function + class registry | Supabase (Edge Function + 2 tables) | Free plan |

You don't run any server of your own.

| Page | Who | What |
|---|---|---|
| `index.html` | Attendees | Landing page with countdown. Shows "Join" once the presenter opens the room |
| `room.html` | Attendees | The live classroom |
| `host.html` → `host-room.html` | Presenter | Password sign-in, then the presenter studio |

## Features

**Stage**
- Screen sharing up to 1080p, with optional tab/system audio, in two quality layers. Phones and weak connections automatically get the lighter 540p layer, which also saves your free bandwidth.
- *Text & slides* mode (sharp, 15 fps) or *video* mode (30 fps), switchable in ⚙.
- The presenter's camera appears picture-in-picture over the screen. Microphone, camera and device switching are all available.
- Full-screen button, live timer and viewer count.

**Presenter controls (only the presenter has them)**
- **Let anyone share their screen**: People → ⋯ → *Allow screen share*. You can also allow mic, allow camera, or make someone a *co-presenter*.
- **Take off stage**: their share disappears for everyone at once. *Stop their screen share* and *Mute microphone* also work per person.
- **Chat mode**: *Everyone*, *Questions to me* (attendees message only you, privately) or *Off*.
- **Chat moderation**: delete a message for everyone, pin a message as an announcement, mute one person in chat. Chat is also rate-limited (4 messages per 5 seconds per person).
- **Emoji reactions** on or off. **Raise hand** on or off, with a queue, a sound alert and *Lower all hands*.
- **Show / hide the attendee list** from attendees.
- **Pinned announcement banner**, **live polls** (up to 6 options, results live or revealed at the end), **Mute everyone**, **Clear the stage**.
- **Remove** a participant (they can't rejoin), **Lock room**, and **End class for everyone** with your `CLOSING_MESSAGE`.
- **Download chat transcript.** Chat, polls and settings survive a refresh of the presenter's page.

**Attendees**
- Join with just a name. Chat with an emoji picker; links are clickable.
- Late joiners receive the recent chat and the current poll.
- Floating reactions, raise hand and voting.
- A *Share screen* / *Unmute* button appears when they're invited.
- If the presenter's connection drops, attendees see "waiting for presenter" and reconnect to them automatically.

## How it works

```
 Presenter browser ──push screen/cam/mic──►  Cloudflare Realtime SFU  ──►  200 attendee browsers
        ▲   "room" data channel (state, chat, polls, reactions) ─────────►       │
        └──────────── each attendee's private "up" channel (chat, hand, votes) ◄─┘

 Every SFU call goes through the Supabase Edge Function "classroom", which
 adds the secret Cloudflare key and signs each session. The function also
 keeps a tiny registry (is the class open? who joined?) in two tables.
```

- **The presenter's browser is in charge.** Attendees' messages go only to the presenter. The presenter's page applies the rules (chat mode, mutes, who may share) and broadcasts what everyone should see. An attendee's screen share is only shown if the presenter granted it.
- **Secrets stay server-side.** The Cloudflare key and host password are Supabase secrets. Each SFU session is signed by the function, so nobody can tamper with someone else's connection.
- The client uses Cloudflare's open-source [partytracks](https://github.com/cloudflare/partykit/tree/main/packages/partytracks) (vendored in `js/vendor/`) for media. It follows the patterns in [cloudflare/realtime-examples](https://github.com/cloudflare/realtime-examples) and Cloudflare's [Meet](https://github.com/cloudflare/orange) app.

## Setup (about 15 minutes, all free)

### 1. Cloudflare: create a Realtime SFU app
1. Sign up at <https://dash.cloudflare.com/sign-up>. It's free and needs no card.
2. Go to **Realtime → SFU → Create** (<https://dash.cloudflare.com/?to=/:account/realtime/sfu/create>).
3. Copy the **App ID** and **App Token**.
4. Optional but recommended: **Realtime → TURN → Create**, then copy the **Key ID** and **API Token**. This helps attendees on strict office or school networks connect, and shares the same free 1,000 GB.

### 2. Supabase: tables, secrets, function
1. **Tables.** In the Supabase dashboard, open SQL Editor, paste the files in `supabase/migrations/` and click Run. If the GitHub integration is connected, a push applies it automatically.
2. **Secrets.** Go to Edge Functions → Secrets (<https://supabase.com/dashboard/project/leqizarzgfpiriknpnxw/functions/secrets>) and add:

   | Name | Value |
   |---|---|
   | `CF_SFU_APP_ID` | Realtime SFU App ID |
   | `CF_SFU_APP_TOKEN` | Realtime SFU App Token |
   | `HOST_PASSWORD` | the presenter password you want |
   | `CF_TURN_KEY_ID` | *(optional)* TURN Key ID |
   | `CF_TURN_KEY_TOKEN` | *(optional)* TURN API Token |
   | `MAX_PARTICIPANTS` | *(optional)* default `300` |

   *Alternative:* the function also reads these from **Supabase Vault** as `lv_cf_sfu_app_id`, `lv_cf_sfu_app_token`, `lv_host_password` (etc.), via `public.lv_config()`, which only the service role can call. This project is set up that way. Change a value with `select vault.update_secret((select id from vault.secrets where name='lv_host_password'), 'new-password');`.

3. **Function.** The GitHub integration deploys `supabase/functions/classroom` on push. Or run `supabase functions deploy classroom --no-verify-jwt`. JWT verification must stay off (`supabase/config.toml` sets this), because the function does its own checks.

### 3. Publish
Merge to `main`. The GitHub Pages workflow publishes the site. Then open `/host.html`, sign in and click **Start the class**.

### Class reminders

People who open a class link and tap **Remind me & join automatically** get
push notifications 1 day, 1 hour and 10 minutes before, and a "Live now — tap
to join" alert when the presenter opens the room. Tapping any of them opens
the class page, which takes them in as soon as the class is live.

- `sw.js` shows the notifications; `supabase/functions/classroom/webpush.js`
  encrypts and signs them (plain WebCrypto, no extra service or account).
- The `lv-reminders` pg_cron job calls the function every minute
  (`remind-run`, checked against the Vault secret `lv_cron_secret`).
- The push key pair is created by the function on first use and kept in
  Vault (`lv_vapid_public`, `lv_vapid_private`).
- iPhone: only works after "Add to Home Screen" (iOS 16.4+); the page says
  so and offers a calendar file with the same 3 alarms.

### How far the free allowance goes
Only traffic **to** viewers counts. A 90-minute class with 200 viewers uses roughly **70–160 GB**, depending on how much of the screen moves and how many viewers are on phones (they get the light layer). That's about **6–12 classes a month** inside the free 1,000 GB. Cloudflare's dashboard shows your usage. Past 1,000 GB the price is $0.05/GB, so set a usage alert if you're close.

Supabase free-plan usage is tiny: about 20 function calls per attendee per class.

### Configuration (`config.js`)
| Key | Meaning |
|---|---|
| `BRAND_SHORT`, `CLASS_TITLE`, `PRESENTER_NAME` | Branding in the room (the title can also be changed live) |
| `ROOM_PREFIX` | Room name base. The ISO week is appended, so each week gets a fresh room |
| `CLASSROOM_API` | Leave empty to use `SUPABASE_URL/functions/v1/classroom` |
| `CLOSING_MESSAGE` | Shown to everyone when the class ends |
| `TRAINING_*` | Countdown schedule on the landing page |

## Tips for a smooth class
- Presenter: use Chrome or Edge on a computer with a wired connection or strong Wi-Fi and at least 5 Mbps upload. **Keep the presenter tab open and in front**, because it runs the class.
- Share a **window or tab** rather than the whole screen, so notifications stay private.
- Use *Questions to me* chat mode during the lesson and *Everyone* for Q&A.
- If you refresh or drop off, attendees wait and reconnect to you automatically. Chat, polls and settings are restored.

## Known limits
- **Remove** stops someone from rejoining and closes their app, but someone technical could keep a copy of the video stream running until the class ends.
- A presenter session can hold about 1,000 attendee connections (a browser limit). Rejoins count too, and refreshing the presenter page resets the count.
- I tested everything against a local stand-in for Cloudflare's server. The first class on the real Cloudflare service is the final check, so do a 5-minute rehearsal with a couple of phones first.

## Local development & tests

```bash
npm install
npm run fakesfu        # local stand-in for Cloudflare Realtime SFU (needs Go)
npm run dev            # http://localhost:5173, host password "test"
npm run test:e2e       # 26 end-to-end checks in headless Chromium
node dev/reminders-test.mjs   # reminder schedule + push encryption (no server needed)
node dev/webpush-test.mjs     # push encryption against RFC 8291's example
node dev/schedule-e2e.mjs     # scheduling, reminders, auto-join
(cd dev/fakesfu && go build -o loadbot ./loadbot) && LOADBOT=dev/fakesfu/loadbot npm run test:load
```

`dev/fakesfu` implements the subset of the Realtime SFU HTTPS API the app uses: sessions, push/pull tracks with simulcast, and data channels. It exists only for tests.
