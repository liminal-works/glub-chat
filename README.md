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