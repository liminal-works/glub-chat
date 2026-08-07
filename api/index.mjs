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
import { fetchPreview } from "./preview.mjs";
import { createLightning } from "./lightning.mjs";
import { createCashu } from "./cashu.mjs";
import { createPatrons } from "./patrons.mjs";
import { createAdmin, attachConsole } from "./admin.mjs";

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
// history buffer bounds. instead of one global newest-N (which let a busy
// channel evict quiet ones), the prune is two-tier: each channel keeps its
// newest PER_CHANNEL_MAX events (fair depth), and only the MAX_CHANNELS
// most-recently-active geohashes are retained (bounded breadth). total rows are
// capped at PER_CHANNEL_MAX * MAX_CHANNELS - events are tiny, so ~120k rows is a
// few tens of MB on disk. Tune via env.
const PER_CHANNEL_MAX = Number(process.env.API_PER_CHANNEL_MAX) || 120;
const MAX_CHANNELS = Number(process.env.API_MAX_CHANNELS) || 1000;
const PRUNE_INTERVAL_MS = 60_000;
// ephemeral media uploads: size + item caps (anti-flood), 24h TTL in media.mjs.
const MEDIA_MAX_BYTES = Number(process.env.API_MEDIA_MAX_BYTES) || 10 * 1024 * 1024;
const MEDIA_MAX_ITEMS = Number(process.env.API_MEDIA_MAX_ITEMS) || 50;
const MEDIA_DIR = process.env.API_MEDIA_DIR || path.join(__dirname, "media-tmp");
// the public origin baked into shared media urls (they're read by other clients,
// so they must be absolute). Falls back to the request's forwarded host.
const PUBLIC_ORIGIN = (process.env.API_PUBLIC_ORIGIN || "").replace(/\/+$/, "");

// --- patronage -------------------------------------------------------------
// A lightning donation buys a NIP-05 identity under NIP05_DOMAIN. All of it is
// off unless LNBITS_URL + LNBITS_INVOICE_KEY are set: with no backend the bot
// simply doesn't offer the commands, rather than offering them and failing.
const PATRON_DB = process.env.PATRON_DB || path.join(__dirname, "glub-patrons.db");
// A FIXED sat amount, not a live peg, so it drifts with the price and wants an
// occasional nudge. 7760 was $5.00 at $64,424/BTC on 2026-08-06 - the date is here
// so the staleness is visible rather than something to re-derive.
const PATRON_SATS = Number(process.env.PATRON_SATS) || 7760;
// An hour is long enough to find a wallet and short enough that the one-open-
// invoice-per-pubkey rule doesn't strand anyone who wandered off mid-payment.
const PATRON_INVOICE_TTL_SEC = Number(process.env.PATRON_INVOICE_TTL_SEC) || 3600;
const PATRON_RENAME_COOLDOWN_SEC = Number(process.env.PATRON_RENAME_COOLDOWN_SEC) || 7 * 24 * 3600;
const PATRON_SWEEP_MS = Number(process.env.PATRON_SWEEP_MS) || 20_000;
const NIP05_DOMAIN = process.env.NIP05_DOMAIN || "glub.chat";
// cashu: the ecash the bot holds is a bearer token, so the default posture is not to
// hold it. Above the threshold the vault is emptied to PATRON_PAYOUT_ADDRESS without
// anyone being awake; with no address set it accumulates and waits for !vault sweep.
const PATRON_PAYOUT_ADDRESS = process.env.PATRON_PAYOUT_ADDRESS || "";
const PATRON_SWEEP_THRESHOLD_SATS = Number(process.env.PATRON_SWEEP_THRESHOLD_SATS) || 10_000;
const PATRON_PROOFS = process.env.PATRON_PROOFS || path.join(__dirname, "glub-proofs.json");
// Admin authorisation. The rotating code is printed on every console line and
// redeemed in chat with !auth; GLUB_ADMIN_PUBKEYS is the optional permanent list for
// operators who shouldn't have to redeem anything.
const admin = createAdmin({
	statePath: process.env.ADMIN_STATE || path.join(__dirname, "glub-admin.json"),
	envPubkeys: (process.env.GLUB_ADMIN_PUBKEYS || "").split(","),
	codeTtlSec: Number(process.env.ADMIN_CODE_TTL_SEC) || 420,
	botName: process.env.GLUB_BOT_NAME || "glub.bot",
});
// installed immediately, so every line from here on carries the code
attachConsole(admin);
console.log(`[admin] code is the prefix on every line · !auth <code> in any channel`);

// A cashu mint and LNbits present the same two methods, so picking between them is
// just which one is configured. The mint wins if both are: it's the one that needs no
// account anywhere, and running both at once would split donations across two ledgers.
function chooseBackend() {
	if (process.env.CASHU_MINT_URL) {
		return createCashu({
			mintUrl: process.env.CASHU_MINT_URL,
			proofsPath: PATRON_PROOFS,
			payout: PATRON_PAYOUT_ADDRESS,
			sweepThresholdSats: PATRON_SWEEP_THRESHOLD_SATS,
		});
	}
	return createLightning({ url: process.env.LNBITS_URL, invoiceKey: process.env.LNBITS_INVOICE_KEY });
}

const store = openStore(DB_PATH);

// keep the buffer fairly bounded (per-channel depth + channel-count breadth)
const pruneHistory = () => store.prune({ perChannelMax: PER_CHANNEL_MAX, maxChannels: MAX_CHANNELS });
pruneHistory();
setInterval(pruneHistory, PRUNE_INTERVAL_MS).unref();

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
// declared after the aggregator and before the bot: the sweep announces a settled
// donation through the bot, and the bot serves the commands that create one.
const patronBackend = chooseBackend();
const patrons = createPatrons({
	dbPath: PATRON_DB,
	backend: patronBackend,
	amountSats: PATRON_SATS,
	invoiceTtlSec: PATRON_INVOICE_TTL_SEC,
	renameCooldownSec: PATRON_RENAME_COOLDOWN_SEC,
	domain: NIP05_DOMAIN,
	// defaults to https://<domain>/.well-known/nostr.json; override when the
	// published list lives somewhere this api doesn't serve
	nip05Url: process.env.PATRON_NIP05_URL || undefined,
	onSettled: (patron, invoice) => bot?.announcePatron(patron, invoice),
});

if (patrons.configured) {
	const sweep = async () => {
		try {
			const { settled, collected } = await patrons.sweep();
			if (settled) console.log(`[patrons] ${settled} donation(s) settled`);
			if (collected) console.log(`[patrons] ${collected} donation(s) collected into the vault`);
			// Emptying the vault is separate from filling it: a mint that can issue may
			// still be unable to pay out, and a failed sweep must not roll back a
			// collection that already succeeded.
			if (patronBackend.sweepToPayout) {
				const out = await patronBackend.sweepToPayout();
				if (out?.status === "sent") console.log(`[patrons] auto-swept ${out.amount} sats to payout`);
			}
		} catch (e) {
			console.error("[patrons] sweep failed:", e.message);
		}
	};
	setInterval(sweep, PATRON_SWEEP_MS).unref();
	sweep(); // a restart shouldn't leave a donation paid while we were down unnoticed

	// Prove the backend actually works, at BOOT, rather than letting the first
	// !donate be the thing that discovers it doesn't. The chat reply for a failed
	// donation is deliberately generic ("couldn't reach the lightning node") because
	// a public channel is the wrong place for internals - but that means a missing
	// dependency, an unreachable mint and a wrong url all look identical to the one
	// person who can fix them. This is where they stop looking identical.
	if (patronBackend.ready) {
		patronBackend
			.ready()
			.then(() => console.log(`[patrons] backend ok: ${patronBackend.stats?.().mint || "configured"}`))
			.catch((e) => {
				console.error(`[patrons] BACKEND UNUSABLE - !donate will fail: ${e.message}`);
				if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(e.message)) {
					console.error("[patrons] the cashu client isn't installed here. run: npm install");
				} else {
					console.error(`[patrons] check CASHU_MINT_URL (${process.env.CASHU_MINT_URL || "unset"}) is reachable from this host`);
				}
			});
	}
	console.log(
		`patrons: ${PATRON_SATS} sats -> nip-05 on ${NIP05_DOMAIN} (via ${patronBackend.kind || "lnbits"})` +
			(PATRON_PAYOUT_ADDRESS ? `, auto-sweep over ${PATRON_SWEEP_THRESHOLD_SATS} sats` : ""),
	);
	if (patronBackend.kind === "cashu" && !PATRON_PAYOUT_ADDRESS) {
		console.warn(
			"[patrons] no PATRON_PAYOUT_ADDRESS: donations will accumulate as ecash on this box. " +
				`That file is the money - set a payout address or sweep it regularly (${PATRON_PROOFS})`,
		);
	}
} else {
	console.log("patrons: disabled (set CASHU_MINT_URL, or LNBITS_URL + LNBITS_INVOICE_KEY, to enable)");
}

bot = createBot({
	store,
	broadcast: (ev, geo) => aggregator.broadcast(ev, geo),
	patrons,
	vault: patronBackend,
	admin,
	nip05Domain: NIP05_DOMAIN,
});
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
	// deliberately no admin code here: /api/health is public, and the code's whole
	// security model is that reading it requires terminal access
	res.json({ ok: true, ...store.stats(), relays: aggregator.stats(), bot: bot.stats(), patrons: patrons.stats(), admin: admin.stats() });
});

// NIP-05 resolution: `?name=<local>` -> { names: { local: pubkey } }. Clients fetch
// this from the ROOT domain, not from /api, so the static server forwards this one
// path here (server/index.mjs) - the api owns the data, the domain owns the name.
//
// A miss is a 200 with an empty map, not a 404: NIP-05 says an unknown name simply
// isn't there, and a 404 makes clients report the whole domain as broken instead of
// the one name as unverified.
app.get("/.well-known/nostr.json", ipBucket({ capacity: 60, refillPerSec: 5 }), (req, res) => {
	const name = typeof req.query.name === "string" ? req.query.name : "";
	// no-store: a cached miss outlives the donation that fixes it, and a patron
	// watching their new identity fail to verify has no way to know why.
	res.set("Cache-Control", "no-store");
	res.json({ names: patrons.names(name) });
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

// unfurl a link into an OpenGraph card. Rate-limited harder than geocode because
// every miss is an outbound fetch to a stranger's server, not a lookup in a table -
// and see preview.mjs for why that fetch is fenced in as carefully as it is.
app.get("/api/preview", ipBucket({ capacity: 10, refillPerSec: 0.5 }), async (req, res) => {
	const url = String(req.query.url || "");
	if (!url || url.length > 2048 || !/^https?:\/\//i.test(url)) {
		res.status(400).json({ ok: false, error: "bad url" });
		return;
	}
	try {
		const data = await fetchPreview(url);
		res.set("Cache-Control", "public, max-age=21600");
		res.json({ ok: true, preview: data });
	} catch (err) {
		// 404, not 5xx: "this link has no card" is a complete answer to a valid
		// question, and the client caches it rather than asking again forever. 5xx is
		// reserved for our own trouble, which IS worth retrying.
		//
		// Deliberately vague about the reason - distinguishing "no such host" from
		// "that host is on my private network" would turn this into a scanner.
		res.status(404).json({ ok: false, error: "no preview" });
	}
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

// upload media for ephemeral hosting (~24h, capped item count). Images are
// rebuilt from scratch (see media.mjs) so no EXIF/GPS/metadata survives; recorded
// voice notes are validated + hosted as-is (they carry no such metadata). The
// client drops the resulting url into chat as "[image] {url}" or "[voice] {url}".
app.post(
	"/api/media",
	express.raw({ type: ["image/jpeg", "image/png", "image/gif", "audio/webm", "audio/ogg", "audio/mp4"], limit: MEDIA_MAX_BYTES }),
	(req, res) => {
		if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
			res.status(415).json({ ok: false, error: "unsupported media type" });
			return;
		}
		const file = media.put(req.body, (req.headers["content-type"] || "").split(";")[0]);
		if (!file) {
			res.status(415).json({ ok: false, error: "not a valid media file" });
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
