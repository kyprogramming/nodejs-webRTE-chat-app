# PulseRTC

Production-ready WebRTC app — video calls, voice calls, group chat, and file sharing.  
**No Socket.IO** — uses native browser `WebSocket` API + Node.js `ws` package.

## Browser / Mobile Support

| Platform | Support |
|---|---|
| Chrome / Edge (desktop + Android) | ✅ Full |
| Safari (iOS 14.5+ / macOS) | ✅ Full |
| Firefox (desktop + Android) | ✅ Full |
| Samsung Internet | ✅ Full |
| Opera | ✅ Full |

WebSocket is natively supported in **every modern browser and mobile device** since 2012.  
The `ws` npm package is **server-side only** — browsers use the built-in `WebSocket` global.

---

## Features

| Feature | Details |
|---|---|
| 📹 Video call | P2P via WebRTC `RTCPeerConnection` |
| 🎤 Voice call | Audio-only fallback |
| 🖥️ Screen share | `getDisplayMedia`, hot-swaps video track |
| 💬 Group chat | Real-time, all room members |
| 📎 File sharing | Upload → server → shared download link (50 MB max) |
| 🔇 Mic / cam toggle | Live mute without reconnecting |
| 📱 Responsive | Mobile bottom-tab UI, desktop sidebar layout |
| 🔄 Auto-reconnect | Exponential backoff (1s → 30s cap) |
| 🛡️ Security | Helmet CSP, rate limiting, file-type whitelist |

---

## Local Development

```bash
cp .env.example .env    # edit values if needed
npm install
npm run dev             # auto-restarts on file change (Node 18+)
# open http://localhost:3000
```

---

## Deploy to Render (free tier)

### Option A — Blueprint (recommended, one click)

1. Push this repo to **GitHub** (or GitLab / Bitbucket).
2. Go to [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**.
3. Connect your repo — Render reads `render.yaml` automatically.
4. Click **Apply** — done. Your app will be live at  
   `https://pulsertc.onrender.com` (or whatever name you pick).

### Option B — Manual web service

1. Render Dashboard → **New** → **Web Service** → connect repo.
2. Set:
   - **Runtime**: Node
   - **Build Command**: `npm install --omit=dev`
   - **Start Command**: `npm start`
   - **Node version**: 20+ (set in Environment → `NODE_VERSION=20`)
3. Add environment variables (see below).
4. Deploy.

### Environment Variables

| Key | Required | Description |
|---|---|---|
| `NODE_ENV` | yes | Set to `production` |
| `PORT` | auto | Render sets this; leave unset |
| `TURN_URL` | recommended | e.g. `turn:openrelay.metered.ca:80` |
| `TURN_USERNAME` | recommended | TURN username |
| `TURN_CREDENTIAL` | recommended | TURN password |

### Free TURN servers

WebRTC calls between users on **different networks / behind NAT** require a TURN server.  
Free options:

| Provider | Free tier |
|---|---|
| [Open Relay](https://www.metered.ca/tools/openrelay/) | Unlimited, community |
| [Metered.ca](https://www.metered.ca/) | 50 GB/month free |
| [Twilio](https://www.twilio.com/stun-turn) | $0.40/GB, no free tier |
| [Xirsys](https://xirsys.com/) | 500 MB/month free |

---

## Architecture

```
Browser A                  Render (Node.js)              Browser B
    |                           |                             |
    |── WS: join-room ─────────>|                             |
    |<─ WS: room-users ─────────|                             |
    |── WS: offer ─────────────>|── WS: offer ──────────────>|
    |                           |<─ WS: answer ───────────────|
    |<─ WS: answer ─────────────|                             |
    |<── WS: ice-candidate ─────|── WS: ice-candidate ───────>|
    |                           |                             |
    |════════════ WebRTC P2P stream (direct) ════════════════|
```

The server **only relays signalling** — media traffic is always peer-to-peer.

## File Structure

```
pulsertc/
├── server.js          ← Express + WebSocket signalling server
├── render.yaml        ← Render IaC blueprint
├── package.json
├── .env.example
├── .gitignore
└── public/
    ├── index.html     ← Full SPA (HTML + CSS + JS)
    └── uploads/       ← Uploaded files (ephemeral on Render free tier)
```

> **Note on uploads**: Render's free tier uses an ephemeral filesystem — uploaded files  
> are lost on redeploy/restart. For persistent storage use  
> [Render Disks](https://render.com/docs/disks) (paid) or upload to S3/R2/Cloudflare.
