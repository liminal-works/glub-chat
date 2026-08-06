# glub.chat

a location channel for whoever's nearby, or anywhere. glub talks over nostr,
so there's no account to make and no server holding your keys · pick a name
and you're in.

## what it is

every place on earth maps to a [geohash](https://en.wikipedia.org/wiki/Geohash),
and every geohash is a channel. tune into `#9q5` and you're in the same room
as everyone else pointed at that patch of the map. drop the geohash entirely
and you've got a plain named channel instead, same rules.

glub exists to make that kind of ambient, place rooted chat easy to reach.
open a browser, pick a name, join a channel · nothing to install, nothing to
configure.

## what it does

- generates your identity locally and keeps it there, nothing leaves the device
- joins channels by geohash or by name, with a live picker for what's active right now
- opens a globe you can spin to find a channel, or to read what people left on it
- shows who's around, colors people consistently, and surfaces real conversation over lurkers
- blurs incoming images until you choose to reveal them
- takes photos and voice notes, and keeps the ones you like in a private gallery
- leaves location notes on a channel · a bulletin board that outlives the chat
- supports optional nostr profiles · avatar, bio, zap address, nip05
- sends encrypted direct messages between users
- runs encrypted group chats ("guilds") that no server knows about · see below
- tells you when someone named you in a channel you weren't reading
- dresses your own line with color codes and ambient effects, if you want it to
- carries a small set of local commands (help, weather, time, dice, and a few more)
- can hand off to a lightweight global bot for shared commands like `!top` and `!notes`
- reads and writes in your browser's language where a translation exists

## guilds

a guild is a frequency, and a password is the only thing that tunes you to it.
name and password go through one slow key derivation · half the result is the
encryption key, which never leaves the device, and the other half becomes the
public tag the messages ride on.

so there's no registry, no invite, and nothing to join · two people who type
the same pair are in the same room, and two guilds that share a name but not a
password don't even land on the same tag. relays carry the traffic without
being able to read it.

## server assist (optional)

a separate, optional service that makes glub nicer to run without ever
touching your keys. it never signs and never sends on your behalf, and the
client works completely fine without it.

turn it on and the client:

- backfills deeper history than the open relay pool keeps around
- reads live messages over a single stream instead of holding many relay
  sockets open, lighter on mobile battery and data
- sends by handing the api an already signed event to fan out across relays
- sees who's around via a presence snapshot that feeds the channel list

everything it serves gets re-verified client side, so a down or absent api
never blocks the app · turn assist off and the client goes straight back to
talking to relays directly.

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

when `API_PORT` (or `API_ORIGIN`) is set, the static server transparently
proxies `/api` to the api, so the client reaches it same origin with no
extra config. or point `window.GLUB_API_BASE` at a separately hosted
instance. toggle it per device from the settings popup. note: the sqlite
store uses `node:sqlite`, so the api needs node ≥ 22.5.

## layout

```
server/   tiny express app, serves public/ and (optionally) proxies /api
public/   the client · identity, relay connections, and signing all live here
  js/nostr/       identity, relay list, protocol helpers, relay pool
                  dm.js / guild.js / notes.js each own their own sockets
                  pow.js mines nip-13, nip96.js uploads to nostr.build
  js/ui/          shared ui pieces (the globe, autocomplete, suggest popups)
  js/i18n/        tiny i18n engine and per language dictionaries
  js/format.js    the "&" color/style codes
  js/flair.js     ambient per line effects, all css, no per frame js
  js/app.js       wires it all into the ui
api/      optional assist service, its own process, never holds keys
  store.mjs       sqlite rolling buffer
  aggregator.mjs  relay subscriber, verification, presence tracking
  bot.mjs         global bot commands
  index.mjs       read only http endpoints, live stream, publish fanout
```

## translations

user facing copy lives behind intent named keys in `public/js/i18n/`, a base
dictionary plus per locale overrides. english is the fallback and the
locale is auto detected from the browser. ships with arabic, hindi, korean,
russian and chinese alongside english · plural forms come from
`Intl.PluralRules`, so a locale writes as many as it actually has, and arabic
flips the layout to rtl.

to add a language, copy `en.js` to a new locale file, translate the values
while keeping the keys and `{placeholders}` exactly, and register it in
`js/i18n/index.js`.
