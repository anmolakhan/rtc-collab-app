# RTC Collab — Real-Time Communication App

A video conferencing + collaboration tool built for Task 4:
video calling (multi-user), screen sharing, file sharing, a shared whiteboard,
JWT-based auth, and encrypted media (via WebRTC's mandatory DTLS-SRTP).

## Stack
- **Backend:** Node.js, Express, Socket.io (signaling), JWT + bcrypt (auth), Multer (file uploads)
- **Frontend:** Vanilla JS, WebRTC (mesh topology), HTML5 Canvas (whiteboard)
- **Media transport:** WebRTC peer-to-peer, encrypted end-to-end (DTLS-SRTP) — the server never touches raw audio/video, only signaling messages (SDP offers/answers, ICE candidates)

## How it works
1. **Auth** — `/api/register` and `/api/login` issue a JWT. The Socket.io connection is authenticated with that JWT in `socket.handshake.auth.token`; unauthenticated sockets are rejected server-side.
2. **Signaling** — Socket.io relays WebRTC `offer`/`answer`/`ICE candidate` messages between peers in a room. It never sees decrypted media.
3. **Mesh calling** — Each participant opens a direct `RTCPeerConnection` to every other participant (good for small rooms, ~2-6 people; see "Scaling" below for larger rooms).
4. **Screen sharing** — `getDisplayMedia()` grabs the screen track and swaps it in via `RTCRtpSender.replaceTrack()`, so peers don't need a renegotiated connection.
5. **Whiteboard** — Canvas draw events are broadcast to the room over Socket.io and redrawn on each client.
6. **File sharing** — Files upload over HTTPS to `/api/upload` (JWT-protected), then a small metadata message (filename + URL) is broadcast to the room over Socket.io.

## Setup

```bash
cd rtc-app
cp .env.example .env      # set a real JWT_SECRET
npm install
npm start                 # or: npm run dev (with nodemon)
```

Open `http://localhost:3000` in two different browser tabs (or two devices), register two
different usernames, and join the same Room ID from both to test calling.

## Production checklist (not included in this MVP, but needed for real deployment)
- **HTTPS/WSS** — Browsers require a secure context for camera/mic access on any host other
  than `localhost`. Put this behind a reverse proxy (e.g. Nginx) with TLS, or deploy to a host
  that terminates HTTPS for you.
- **TURN server** — STUN alone (included, via Google's public server) isn't enough for users
  behind symmetric NATs/strict firewalls. Add a TURN server (e.g. coturn, or a managed service)
  in `ICE_SERVERS` in `public/client.js`.
- **Persistent database** — Users currently live in an in-memory `Map` in `server.js` and reset
  on restart. Swap in Postgres/Mongo for real accounts.
- **Rate limiting** — Add `express-rate-limit` on `/api/register`, `/api/login`, `/api/upload`.
- **SFU for large rooms** — The mesh topology re-encodes/sends N-1 streams per client, which
  doesn't scale much past ~6 participants. For larger rooms, route media through an SFU like
  mediasoup, LiveKit, or Jitsi Videobridge instead of full mesh.
- **Virus scanning / file type checks** on uploads before serving them back out.

## Project structure
```
rtc-app/
├── server.js            # Express API + Socket.io signaling server
├── package.json
├── .env.example
├── public/
│   ├── index.html        # Auth screen, lobby, call UI, whiteboard overlay
│   ├── style.css
│   └── client.js          # WebRTC mesh logic, screen share, whiteboard, chat, file UI
└── uploads/               # Uploaded files land here (created at runtime)
```
