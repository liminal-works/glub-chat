# glub chat

A web client that speaks [bitchat](https://github.com/permissionlesstech/bitchat)'s geohash-channel
protocol over nostr — chat with native bitchat clients straight from a browser.

## protocol

bitchat's location-based channels are plain nostr:

- each channel is a geohash, carried as a `g` tag (e.g. `["g", "9q5"]`)
- chat messages are ephemeral events, `kind 20000`
- presence/announce events are `kind 20001`
- display names are carried as an `n` tag
- clients connect to a shared pool of public relays and `REQ` for
  `kinds: [20000, 20001]`

The relay list is fetched at runtime from bitchat's own repo:
`https://github.com/permissionlesstech/bitchat/blob/main/relays/online_relays_gps.csv`.

## architecture

- `server/` — a tiny Express app that does nothing but serve `public/` as
  static files. There is no backend chat logic and no API for sending
  messages.
- `public/` — the actual client. Identity (keypair), relay connections, and
  message signing all happen **in the browser**. The secret key is generated
  client-side, stored in `localStorage`, and never sent anywhere — the
  browser opens its own WebSocket connections to relays and signs its own
  events.
  - `public/js/nostr/identity.js` — session keypair (generate/load/store)
  - `public/js/nostr/relayList.js` — fetch + parse bitchat's relay CSV
  - `public/js/nostr/protocol.js` — build/read bitchat-flavored nostr events
  - `public/js/nostr/relayPool.js` — manage relay WebSocket connections,
    subscriptions, and reconnects
  - `public/js/app.js` — wires the above into the UI
- `api/` — an **optional** "server assist" service, deliberately separate from
  the static server (and its own process) so its failure modes can never stop
  the pure client from loading. It subscribes to relays, signature-verifies and
  stores `kind 20000` chat events in a local SQLite db (`node:sqlite`), and
  serves read-only history (`GET /api/health`, `GET /api/history`). It never
  holds keys, never sends messages, and re-served events are re-verified by the
  client. With assist enabled the client backfills deep history the relays no
  longer rebroadcast; without it (api absent, down, or assist toggled off) the
  client runs entirely on its own direct relay subscriptions.
  - `api/store.mjs` — SQLite event store (insert + history queries)
  - `api/aggregator.mjs` — relay subscriber → verify → store
  - `api/index.mjs` — the read-only HTTP endpoints

This is a deliberate departure from the earlier prototype, which ran a
single server-held identity and had the browser hand its raw private key to
the server on every send. Here the server is just a static file host; all
protocol/identity logic is client-side, matching how nostr clients normally
work.

## status

This is the foundation: identity, relay discovery, connecting to relays,
and sending/receiving `kind 20000` chat messages in one focused channel at a
time. Everything else from the prototype (themes, the message board, image
uploads, translation, the AI persona, Cashu wallet/betting, etc.) is left
out for now and will come back — if at all — as separate, deliberate pieces
on top of this base.

## running locally

```bash
cp .env.example .env
npm install
npm start
```

Then open `http://localhost:3000`.

### optional: the history api

The client works without it, but to run the optional "server assist" history
service:

```bash
npm run api    # listens on :3001, writes api/glub-history.db
```

The client looks for the api at same-origin `/api` by default (reverse-proxy
the api there next to the static files), or set `window.GLUB_API_BASE` to a
separately-hosted instance. Toggle it on/off per-device from the settings popup
(tap the topbar status). It starts empty and accumulates history as it runs.