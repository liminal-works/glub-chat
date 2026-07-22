import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { openStore } from "./store.mjs";
import { createAggregator } from "./aggregator.mjs";
import { createBot } from "./bot.mjs";
import { createProfiles } from "./profiles.mjs";
import { proxyAvatar } from "./avatar.mjs";
import { createMediaStore } from "./media.mjs";
import { translateConfigured, translateText } from "./translate.mjs";
import { geocode } from "./geocode.mjs";

// The optional "server assist" API. Deliberately separate from the static file
// server (server/index.mjs) so its failure modes - a wedged relay pool, a full
// disk, a crash - can never stop the pure client from loading. It is read-only:
// it ingests signed events from relays into a store and serves history + a live
// stream. It never holds keys, never sends messages, and the client works fully
// without it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.API_PORT || 3001;
const DB_PATH = process.env.API_DB || path.join(__dirname, "glub-history.db");
const DEFAULT_LIMIT = 200;
const HEARTBEAT_MS = 25_000; // SSE keep-alive comment, under common proxy idle timeouts
// rolling buffer size the client mirrors; events are tiny, so the default is
// generous enough that busy channels don't crowd out quiet ones. Tune via env.
const BUFFER_MAX = Number(process.env.API_BUFFER_MAX) || 2000;
const PRUNE_INTERVAL_MS = 60_000;
// ephemeral media uploads: size + item caps (anti-flood), 24h TTL in media.mjs.
const MEDIA_MAX_BYTES = Number(process.env.API_MEDIA_MAX_BYTES) || 10 * 1024 * 1024;
const MEDIA_MAX_ITEMS = Number(process.env.API_MEDIA_MAX_ITEMS) || 50;
const MEDIA_DIR = process.env.API_MEDIA_DIR || path.join(__dirname, "media-tmp");
// the public origin baked into shared media urls (they're read by other clients,
// so they must be absolute). Falls back to the request's forwarded host.
const PUBLIC_ORIGIN = (process.env.API_PUBLIC_ORIGIN || "").replace(/\/+$/, "");

const store = openStore(DB_PATH);

// keep the buffer bounded: trim to the most-recent BUFFER_MAX events periodically
store.prune(BUFFER_MAX);
setInterval(() => store.prune(BUFFER_MAX), PRUNE_INTERVAL_MS).unref();

// live SSE subscribers; each may scope to a single geohash
const subscribers = new Set(); // { res, geo }

function broadcast(ev, geo) {
	if (subscribers.size === 0) return;
	const line = `data: ${JSON.stringify(ev)}\n\n`;
	for (const sub of subscribers) {
		if (!sub.geo || sub.geo === geo) sub.res.write(line);
	}
}

// the global bot rides the aggregator: it observes every live chat event and
// fans its command replies back out through the aggregator's relay connections.
// declared before the aggregator so onChat can reach it, wired to broadcast after.
let bot;
const aggregator = createAggregator(store, {
	onStored: broadcast,
	onChat: (ev, geo, source) => bot?.observe(ev, geo, source),
});
bot = createBot({ store, broadcast: (ev, geo) => aggregator.broadcast(ev, geo) });
const profiles = createProfiles();
const media = createMediaStore({ dir: MEDIA_DIR, maxItems: MEDIA_MAX_ITEMS });

const app = express();

// the static server proxies /api -> here from loopback and appends the real
// client to x-forwarded-for; trusting loopback makes req.ip resolve to that
// client, so the per-IP rate buckets below see individual users.
app.set("trust proxy", "loopback");

// read-only public data, so any origin may read it (a client may point at this
// api from a different host).
app.use((req, res, next) => {
	res.set("Access-Control-Allow-Origin", "*");
	res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.set("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") return res.sendStatus(204);
	next();
});

// per-IP token-bucket middleware for the abusable write/compute endpoints.
// generous enough that no human ever notices; a script hammering an endpoint
// gets 429s instead of burning relays, disk, or the translation budget.
function ipBucket({ capacity, refillPerSec }) {
	const buckets = new Map(); // ip -> { tokens, last }
	return (req, res, next) => {
		if (buckets.size > 10_000) buckets.clear(); // bound memory under address churn
		const now = Date.now();
		let b = buckets.get(req.ip);
		if (!b) buckets.set(req.ip, (b = { tokens: capacity, last: now }));
		b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
		b.last = now;
		if (b.tokens < 1) {
			res.status(429).json({ ok: false, error: "rate limited" });
			return;
		}
		b.tokens -= 1;
		next();
	};
}

// liveness + how much history we hold + how many relays we're watching; the
// client pings this to decide whether to lean on the api or fall back to relays,
// and to render the assist status indicator.
app.get("/api/health", (req, res) => {
	res.json({ ok: true, ...store.stats(), relays: aggregator.stats(), bot: bot.stats() });
});

// publish a client-signed event: the api fans it out across the relays it
// already has open (so the client doesn't open its own), stores it, and streams
// it back. The client signs locally - we only ever receive a signed event, never
// a key. Re-verified before anything happens to it.
// burst of 12 then ~1 every 2s - matches the client-side sender bucket's
// spirit while leaving room for rebroadcast retries and presence heartbeats
app.post("/api/publish", ipBucket({ capacity: 12, refillPerSec: 0.5 }), express.json({ limit: "32kb" }), (req, res) => {
	const relays = aggregator.publish(req.body);
	if (relays < 0) {
		res.status(400).json({ ok: false, error: "invalid event" });
		return;
	}
	res.json({ ok: true, relays });
});

// translate a message into the viewer's ui language via the configured provider
// (see translate.mjs). the client sends the text (not an event id) so it can
// translate anything on screen - others' messages, replies, even DMs. 503 when
// no provider key is set, so the client can hide the action gracefully.
// translation spends a metered provider budget: burst of 5, then ~4/minute
app.post("/api/translate", ipBucket({ capacity: 5, refillPerSec: 1 / 15 }), express.json({ limit: "16kb" }), async (req, res) => {
	const text = String(req.body?.text || "").trim();
	const target = String(req.body?.target || "en");
	if (!text) {
		res.status(400).json({ ok: false, error: "empty" });
		return;
	}
	if (!translateConfigured()) {
		res.status(503).json({ ok: false, error: "not configured" });
		return;
	}
	try {
		const out = await translateText(text, target);
		res.json({ ok: true, text: out.text, detected: out.detected });
	} catch {
		res.status(502).json({ ok: false, error: "translate failed" });
	}
});

// reverse-geocode a geohash channel to a place name, precision-scoped to the
// geohash length (see geocode.mjs). heavily cached; the light per-IP bucket is
// really just a courtesy cap since cached hits don't hit the provider.
app.get("/api/geocode", ipBucket({ capacity: 20, refillPerSec: 1 }), async (req, res) => {
	const geo = String(req.query.geo || "");
	if (!geo || !/^[0-9a-z]{1,12}$/i.test(geo)) {
		res.status(400).json({ ok: false, error: "bad geohash" });
		return;
	}
	const place = await geocode(geo);
	res.set("Cache-Control", "public, max-age=86400");
	res.json({ ok: true, place });
});

// live presences for a channel (kind-20001 heartbeats the api has seen recently).
// The client merges this with its own talking list to show who's lurking. Requires
// `?geo=` - presence is meaningless without a channel.
app.get("/api/presence", (req, res) => {
	const geo = typeof req.query.geo === "string" ? req.query.geo : "";
	res.json({ users: geo ? aggregator.presenceFor(geo) : [] });
});

// a pubkey's nostr profile metadata (kind 0), fetched from profile relays and
// cached. the raw picture url stays server-side (the browser fetches the image
// via /api/avatar so its IP never reaches the image host); we only report whether
// an avatar exists. null when no profile is found.
app.get("/api/profile", async (req, res) => {
	const pubkey = String(req.query.pubkey || "").toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(pubkey)) {
		res.status(400).json({ error: "bad pubkey" });
		return;
	}
	const force = req.query.force === "1";
	const profile = await profiles.get(pubkey, { force });
	res.set("Cache-Control", force ? "no-store" : "public, max-age=60");
	res.json({
		profile: profile
			? {
					name: profile.name,
					about: profile.about,
					nip05: profile.nip05,
					website: profile.website,
					lud16: profile.lud16,
					hasAvatar: !!profile.picture,
					hasBanner: !!profile.banner,
					updated: profile.updated, // revision token; the client appends it to image urls to bust stale avatars/banners
			  }
			: null,
	});
});

// proxy a profile image (avatar or banner) by pubkey (privacy: keeps the
// viewer's IP off the image host). The url is looked up server-side from the
// cached profile and SSRF-guarded; the raw url never reaches the client.
async function serveProfileImage(req, res, field) {
	const pubkey = String(req.query.pubkey || "").toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(pubkey)) {
		res.status(400).end();
		return;
	}
	const profile = await profiles.get(pubkey);
	if (!profile || !profile[field]) {
		res.status(404).end();
		return;
	}
	await proxyAvatar(profile[field], res);
}

app.get("/api/avatar", (req, res) => serveProfileImage(req, res, "picture"));
app.get("/api/banner", (req, res) => serveProfileImage(req, res, "banner"));

// upload an image for ephemeral hosting (~24h, capped item count). The payload
// is rebuilt from scratch (see media.mjs) so no EXIF/GPS/metadata survives, then
// hosted at a plain extension-suffixed url the client drops into chat as
// "[image] {url}" (the marker native bitchat clients recognize).
app.post(
	"/api/media",
	express.raw({ type: ["image/jpeg", "image/png", "image/gif"], limit: MEDIA_MAX_BYTES }),
	(req, res) => {
		if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
			res.status(415).json({ ok: false, error: "unsupported media type" });
			return;
		}
		const file = media.put(req.body, (req.headers["content-type"] || "").split(";")[0]);
		if (!file) {
			res.status(415).json({ ok: false, error: "not a valid image" });
			return;
		}
		// return a relative path by default and let the client absolutize it against
		// its own (authoritative) origin - so https just works without guessing at
		// the scheme from proxy headers. PUBLIC_ORIGIN forces an absolute url only
		// when media should live on a different origin than the browsing one.
		const url = PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN}/api/media/${file}` : `/api/media/${file}`;
		res.json({ ok: true, url });
	}
);

app.get("/api/media/:file", (req, res) => {
	const item = media.get(String(req.params.file || ""));
	if (!item) {
		res.status(404).end();
		return;
	}
	res.set("Content-Type", item.mime);
	res.set("Cache-Control", "public, max-age=86400, immutable");
	res.sendFile(item.path);
});

// newest-first history, optionally scoped to a geohash and paged with `before`.
app.get("/api/history", (req, res) => {
	const geo = typeof req.query.geo === "string" ? req.query.geo : "";
	const before = Number(req.query.before);
	const limit = Number(req.query.limit);
	const events = store.history({
		geo,
		before: Number.isFinite(before) ? before : 0,
		limit: Number.isFinite(limit) ? limit : DEFAULT_LIMIT,
	});
	res.json({ events });
});

// location notes for a channel + everything nested under it. `?geo=` is a geohash
// PREFIX: the server keeps a persistent cache of kind-1 geohash notes and answers
// with every cached note whose geohash starts with it (newest first, unexpired) -
// the prefix match relays can't do. This is the server-assist path for notes; the
// client re-verifies each returned event's signature.
app.get("/api/notes", ipBucket({ capacity: 20, refillPerSec: 1 }), (req, res) => {
	const geo = String(req.query.geo || "").toLowerCase();
	if (!/^[0-9a-z]{1,32}$/.test(geo)) {
		res.status(400).json({ ok: false, error: "invalid geohash" });
		return;
	}
	const limit = Number(req.query.limit);
	const notes = store.notesByPrefix(geo, Number.isFinite(limit) ? limit : DEFAULT_LIMIT);
	res.json({ notes });
});

// live event stream (SSE). A client with server-assist on listens here for new
// events instead of opening its own relay read-subscriptions. `?geo=` scopes the
// stream to one channel so a focused view doesn't receive every channel's chatter.
app.get("/api/stream", (req, res) => {
	res.set({
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no", // tell nginx not to buffer the stream
	});
	res.flushHeaders();

	const geo = typeof req.query.geo === "string" && req.query.geo ? req.query.geo : "";
	const sub = { res, geo };
	subscribers.add(sub);
	res.write(": connected\n\n");

	const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
	req.on("close", () => {
		clearInterval(heartbeat);
		subscribers.delete(sub);
	});
});

app.listen(PORT, () => {
	console.log(`glub-chat api on http://localhost:${PORT} (db: ${DB_PATH})`);
});

aggregator.start();
profiles.start();
