# glub.chat

geohash-linked user broadcast over nostr — drop into a location channel and talk
to whoever's there, native [bitchat](https://github.com/permissionlesstech/bitchat)
clients included, straight from a browser.

no accounts. no email. no servers holding your keys. pick a name and go.

> nostr = *notes and other stuff transmitted by relays*. glub = *geohash-linked
> user broadcast*. it checks out.

## what it is

glub talks bitchat's location-channel protocol, which under the hood is just
plain nostr. every place on earth is a [geohash](https://en.wikipedia.org/wiki/Geohash),
and every geohash is a channel. tune into `#9q5` and you're in the same room as
everyone else — phones running bitchat, other browsers running glub — pointed at
that patch of the map.

## the protocol

it's all ordinary nostr events with a couple of conventions:

- each channel is a geohash, carried as a `g` tag — `["g", "9q5"]`
- chat messages are ephemeral `kind 20000` events
- presence ("i'm here") is `kind 20001` — how the user list knows who's lurking
- your display name rides along as an `n` tag
- glub always posts with a `t: teleport` tag — you're chatting *into* a geohash,
  not physically standing in it like a phone on a mesh would be
- clients connect to a shared pool of public relays and `REQ` for
  `kinds: [20000, 20001]`

the relay pool is fetched at runtime from bitchat's own repo
([`online_relays_gps.csv`](https://github.com/permissionlesstech/bitchat/blob/main/relays/online_relays_gps.csv)),
so glub and bitchat stay pointed at the same relays.

## pure client

your identity is a nostr keypair generated **in your browser**, stored in
`localStorage`, and never sent anywhere. the browser opens its own relay sockets
and signs its own events. the static server is a dumb file host — it doesn't know
who you are and couldn't send a message as you if it tried.

this is the whole point. an earlier prototype kept one server-held identity and
had the browser hand over its raw private key on every send. never again — keys
stay on your device, like a nostr client should.

## server assist (optional)

a separate, optional service that makes glub nicer to run without ever touching
your keys. it never signs, never sends as you, and the client works completely
fine without it.

it casts a much wider net than a browser can — subscribing to the whole relay
pool, signature-verifying everything, and keeping a bounded rolling buffer of
recent chat in sqlite. turn assist on and the client:

- **backfills** deep history the relays no longer rebroadcast
- **reads** live messages over one server-sent-events stream instead of holding
  dozens of relay sockets open — much lighter on mobile bandwidth and battery
- **sends** by handing the api its already-signed event to fan out across every
  relay it's connected to (so an assisted client opens *zero* relay sockets)
- **sees** who's around via a presence snapshot that feeds the channel user list

everything it serves is re-verified client-side, so a down, absent, or even
compromised api can't forge a message or hold the app hostage — flip assist off
and the client drops straight back to talking to relays directly.

## running locally

```bash
cp .env.example .env
npm install
npm start            # serves the client on http://localhost:3000
```

open `http://localhost:3000` and you're in.

### with the assist api

optional. the client runs without it.

```bash
npm run api          # listens on :3001, writes api/glub-history.db
```

when `API_PORT` (or `API_ORIGIN`) is set, the static server transparently proxies
`/api` → the api, so the client reaches it same-origin with no extra config. or
point `window.GLUB_API_BASE` at a separately-hosted instance. toggle it per-device
from the settings popup (tap the topbar status). it starts empty and fills up as
it runs. note: the sqlite store uses `node:sqlite`, so the api needs **node ≥ 22.5**.

## layout

```
server/   tiny express app — serves public/ and (optionally) proxies /api
public/   the client. identity, relay connections, signing — all in the browser
  js/nostr/identity.js    session keypair (generate / load / store)
  js/nostr/relayList.js   fetch + parse bitchat's relay csv
  js/nostr/protocol.js    build / read bitchat-flavored nostr events
  js/nostr/relayPool.js   manage relay sockets, subscriptions, reconnects
  js/app.js               wires it all into the ui
api/      optional assist service — its own process, never holds keys
  store.mjs       sqlite rolling buffer (insert + history queries)
  aggregator.mjs  relay subscriber → verify → store + presence tracking
  index.mjs       read-only http endpoints + live stream + publish fanout
```

## status

what works today: keypair identity, relay discovery, joining a geohash channel,
sending and receiving chat, per-user colors ported from bitchat's exact algorithm,
a channel user list (who's talking, plus detected "ghosts"), blurred tap-to-reveal
image previews, send confirmation with automatic rebroadcast, and the optional
server assist above.

it's intentionally focused. the kitchen sink from the old prototype (themes, the
message board, translation, the ai persona, cashu wallet/betting, and the rest)
is left out, to come back — if at all — as deliberate pieces on top of this base.
