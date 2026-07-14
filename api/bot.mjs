// The global bot: a server-side participant that watches every geohash channel
// through the aggregator's firehose and answers `!commands` by posting an
// ordinary signed chat message back into the channel. Native bitchat clients
// (which have no global view) get commands like `!top` that surface glub's
// server-side index of the whole network.
//
// This is a faithful port of the old standalone glub bot: the same command set,
// aliases, scoring, language detection (franc) and reply text. What's new is
// *where it lives* - instead of holding its own relay sockets it rides the
// aggregator: observe() is fed each live chat event, and replies fan out through
// the aggregator's existing connections. !top is the first command; the plumbing
// (observe/parse/alias/cooldown/dispatch/reply) is shared so !listen etc. slot in
// beside it.

import crypto from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { franc } from "franc";
import { CHAT_KIND, getName } from "./nostr.mjs";
import { geohashToLatLon, countryCodeToFlag } from "./geo.mjs";

const now = () => Math.floor(Date.now() / 1000);

// long messages are clipped with a char count, so a !listen line can't blow out
// the reply (ported verbatim).
function clipText(s, max = 200) {
	const str = String(s ?? "");
	if (str.length <= max) return str;
	return str.slice(0, max) + `... (${str.length} chars)`;
}

// compact "23s / 4m / 2h / 3d" elapsed label (ported verbatim).
function timeAgo(nowSec, thenSec) {
	const d = Math.max(0, nowSec - thenSec);
	if (d < 60) return `${d}s`;
	const m = Math.floor(d / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

// ---- tunables (ported verbatim from the old bot) --------------------------
const ACTIVE_WINDOW_SEC = 60; // a pubkey counts as "active" if seen within this
const ACTIVITY_WINDOW_SEC = 60; // !top scores messages seen in the last minute (mpm)
const LANG_MIN_CHARS = 160; // don't detect a channel's language below this much text
const LANG_MAX_CHARS = 800; // keep only the most recent ~800 chars per channel
const LANG_RECHECK_EVERY = 6; // re-run franc every N messages
const LISTEN_BUFFER_SIZE = 800; // cross-channel recent-message ring for !listen
const RECENT_BY_LANGUAGE_MAX = 10; // recent messages kept per detected language
const LISTEN_SHOW = 10; // how many messages a !listen reply shows
const COMMAND_COOLDOWN_WINDOW_MS = 60_000; // global command budget window
const COMMAND_COOLDOWN_MAX = 12; // ...and how many commands fit in it
const GEO_CACHE_MAX = 5000; // reverse-geocode cache bound
const GEOCODE_TIMEOUT_MS = 2500; // per reverse-geocode; a flag must never stall a reply
const NOMINATIM_UA = "glub.chat-bot (https://glub.chat)";

// createBot({ broadcast, botName })
//   broadcast(signedEvent, geohash)  fan the reply out (the aggregator supplies it)
//   botName                          the `n` tag / display handle (default "bot")
export function createBot({ broadcast, botName = process.env.GLUB_BOT_NAME || "bot" } = {}) {
	// --- identity ------------------------------------------------------------
	// stable across restarts when GLUB_BOT_SK (64-hex) is set; otherwise a fresh
	// ephemeral key each boot (fine for dev, logged loudly so prod sets one).
	let skHex = (process.env.GLUB_BOT_SK || "").trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(skHex)) {
		skHex = crypto.randomBytes(32).toString("hex");
		console.warn("[bot] GLUB_BOT_SK not set - using an ephemeral identity (set GLUB_BOT_SK to keep a stable one)");
	}
	const sk = Uint8Array.from(Buffer.from(skHex, "hex"));
	const pk = getPublicKey(sk);
	console.log(`[bot] identity ${pk.slice(0, 8)}…${pk.slice(-4)} name=${botName}`);

	// --- rolling state -------------------------------------------------------
	const channelActivity = new Map(); // geohash -> [created_at secs] (rolling 60s window) → !top score
	const activePubkeys = new Map(); // pubkey -> lastSeen secs → active-user count
	const langBlob = new Map(); // geohash -> { blob, n } accumulating text for detection
	const channelLanguage = new Map(); // geohash -> { lang, updated } (ISO 639-3, e.g. "eng")
	const geoNameCache = new Map(); // geohash -> { country_code, geocodable } (reverse-geocode cache)
	const commandHits = []; // ms timestamps of recently-served commands (global cooldown)
	const recentOther = []; // cross-channel recent messages, newest last → !listen
	const recentByLanguage = new Map(); // ISO-639-3 lang -> [{ g, user, msg, t }] → !listen <lang>

	// --- activity + language bookkeeping ------------------------------------
	function recordChannelActivity(geohash, tsSec) {
		if (!geohash) return;
		const t = typeof tsSec === "number" && tsSec > 0 ? tsSec : now();
		let arr = channelActivity.get(geohash);
		if (!arr) channelActivity.set(geohash, (arr = []));
		arr.push(t);
		const cutoff = t - ACTIVITY_WINDOW_SEC;
		while (arr.length && arr[0] < cutoff) arr.shift();
	}

	function noteActivePubkey(pubkey, tsSec) {
		if (!pubkey) return;
		activePubkeys.set(pubkey, typeof tsSec === "number" ? tsSec : now());
	}

	function activeUserCount() {
		const cutoff = now() - ACTIVE_WINDOW_SEC;
		for (const [pkey, t] of activePubkeys) if (t < cutoff) activePubkeys.delete(pkey);
		return activePubkeys.size;
	}

	// accumulate a channel's chat text and periodically re-detect its dominant
	// language with franc; the result is what !top prints beside the flag.
	function updateChannelLanguage(g, text) {
		const clean = String(text || "").trim();
		if (!clean) return;

		let st = langBlob.get(g);
		if (!st) langBlob.set(g, (st = { blob: "", n: 0 }));

		st.blob += (st.blob ? " " : "") + clean;
		st.n++;
		if (st.blob.length > LANG_MAX_CHARS) st.blob = st.blob.slice(st.blob.length - LANG_MAX_CHARS);

		if (st.n % LANG_RECHECK_EVERY !== 0) return;
		if (st.blob.length < LANG_MIN_CHARS) return;

		const lang = franc(st.blob, { minLength: 10 });
		if (!lang || lang === "und") return;
		channelLanguage.set(g, { lang, updated: Date.now() });
	}

	// !top ranking: channels by messages in the last 60s (messages-per-minute).
	function topActiveChannels(limit = 5) {
		const out = [];
		const t = now();
		const cutoff = t - ACTIVITY_WINDOW_SEC;
		for (const [g, arr] of channelActivity.entries()) {
			if (!arr || arr.length === 0) continue;
			while (arr.length && arr[0] < cutoff) arr.shift();
			if (arr.length > 0) out.push({ g, mpm: arr.length, count: arr.length });
		}
		out.sort((a, b) => b.mpm - a.mpm);
		return out.slice(0, limit);
	}

	// --- !listen buffers + formatters (ported verbatim) ----------------------
	// a readable display name for a message author: the `n` tag, else a short key.
	function nameOf(ev) {
		return String(getName(ev) || "").trim() || "anon" + String(ev.pubkey || "").slice(0, 4);
	}

	// cross-channel recent-message ring (newest last), bounded.
	function pushRecent(ev, geohash, content) {
		if (!geohash || !content) return;
		recentOther.push({ g: geohash, t: typeof ev.created_at === "number" ? ev.created_at : now(), name: nameOf(ev), content });
		if (recentOther.length > LISTEN_BUFFER_SIZE) recentOther.splice(0, recentOther.length - LISTEN_BUFFER_SIZE);
	}

	// per-language recent buffer, so !listen <lang> can show what a language sounds
	// like right now. detection is per-message here (not the channel blob).
	function rememberMessageLanguage(g, user, text, createdAt) {
		const clean = String(text || "").trim();
		if (clean.length < 10) return;
		const lang = franc(clean, { minLength: 10 });
		if (!lang || lang === "und") return;
		let arr = recentByLanguage.get(lang);
		if (!arr) recentByLanguage.set(lang, (arr = []));
		arr.push({ g, user, msg: clean, t: createdAt || now() });
		if (arr.length > RECENT_BY_LANGUAGE_MAX) arr.shift();
	}

	// !listen (no arg): recent messages from channels OTHER than the caller's.
	function buildListenOutput(currentG, n) {
		const nowSec = now();
		const picked = [];
		for (let i = recentOther.length - 1; i >= 0 && picked.length < n; i--) {
			const m = recentOther[i];
			if (!m || !m.g || !m.t) continue;
			if (m.g === currentG) continue; // exclude the current channel
			picked.push(m);
		}
		if (picked.length === 0) return "no recent messages from other channels yet";
		picked.reverse(); // oldest -> newest for readability
		return (
			`${picked.length} recent messages:\n` +
			picked.map((m) => `#${m.g} <${m.name}> ${clipText(m.content, 200)} (${timeAgo(nowSec, m.t)} ago)`).join("\n")
		);
	}

	// !listen <#geohash>: recent messages from one specific channel.
	function buildListenOutputForChannel(targetG, n) {
		const picked = [];
		for (let i = recentOther.length - 1; i >= 0 && picked.length < n; i--) {
			const m = recentOther[i];
			if (!m || !m.g || m.g !== targetG) continue;
			picked.push(m);
		}
		if (picked.length === 0) return `no recent messages for #${targetG}`;
		picked.reverse();
		const nowSec = now();
		return (
			`${picked.length} recent in #${targetG}:\n` +
			picked.map((m) => `#${m.g} <${m.name}> ${clipText(m.content, 200)} (${timeAgo(nowSec, m.t)} ago)`).join("\n")
		);
	}

	// !listen <lang>: recent messages detected in an ISO-639-3 language (eng/rus/…).
	function buildListenOutputForLanguage(code, n) {
		const recent = recentByLanguage.get(String(code || "").trim().toLowerCase()) || [];
		if (!recent.length) return `no recent messages detected for: ${code}`;
		const picked = [...recent].slice(-n).reverse();
		const nowSec = now();
		return (
			`${picked.length} recent ${code} messages:\n` +
			picked.map((m) => `#${m.g} <${m.user}> ${clipText(m.msg, 200)} (${timeAgo(nowSec, m.t)} ago)`).join("\n")
		);
	}

	// --- reverse-geocoded flags (Nominatim, cached) -------------------------
	async function geocodeGeohash(g) {
		if (geoNameCache.has(g)) return geoNameCache.get(g);

		const coords = geohashToLatLon(g);
		if (!coords) {
			const result = { country_code: null, geocodable: false };
			cacheGeo(g, result);
			return result;
		}

		let countryCode = null;
		try {
			const url =
				`https://nominatim.openstreetmap.org/reverse?format=json` +
				`&lat=${coords.lat}&lon=${coords.lon}&zoom=10&addressdetails=1&accept-language=en`;
			// hard timeout: the flag is an enrichment and must NEVER stall a reply. A
			// host that can't reach nominatim (or a slow/rate-limited response) would
			// otherwise leave the awaiting !top hanging forever.
			const res = await fetch(url, {
				headers: { "User-Agent": NOMINATIM_UA, "Accept-Language": "en" },
				signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
			});
			if (res.ok) {
				const json = await res.json().catch(() => null);
				if (json?.address) countryCode = String(json.address.country_code || "").toLowerCase() || null;
			}
		} catch {
			// timeout / network hiccup: geocodable-but-unknown (🌐); don't cache a hard miss
			return { country_code: null, geocodable: true };
		}

		const result = { country_code: countryCode, geocodable: true };
		cacheGeo(g, result);
		return result;
	}

	function cacheGeo(g, result) {
		if (geoNameCache.size >= GEO_CACHE_MAX) geoNameCache.clear();
		geoNameCache.set(g, result);
	}

	async function getGeohashFlag(g) {
		const geo = await geocodeGeohash(g);
		if (!geo?.geocodable) return "🌀"; // word-channel / non-geohash
		return countryCodeToFlag(geo?.country_code);
	}

	// --- outgoing ------------------------------------------------------------
	function makeBotChatMessage(content, geohash) {
		return finalizeEvent(
			{
				kind: CHAT_KIND,
				created_at: now(),
				tags: [
					["g", geohash],
					["n", botName],
					["client", "glub.chat"],
				],
				content,
				pubkey: pk,
			},
			sk,
		);
	}

	function reply(content, geohash) {
		if (!content || !geohash) return;
		const ev = makeBotChatMessage(content, geohash);
		const sent = broadcast?.(ev, geohash);
		console.log(`[bot] reply -> #${geohash} (${sent ?? 0} relays)`);
	}

	// --- commands ------------------------------------------------------------
	// !top: the most active channels, messages-per-minute over the last 60s.
	async function cmdTop(geo) {
		const top = topActiveChannels(5);

		if (top.length === 0) {
			reply("top channels: (no activity yet)", geo);
			return;
		}

		const maxG = Math.max(...top.map((x) => x.g.length));
		const flags = await Promise.all(top.map((x) => getGeohashFlag(x.g)));

		const lines = top.map((x, i) => {
			const gPadded = x.g.padEnd(maxG, " ");
			const mpm = x.count.toFixed(1);
			const secs = (60 / x.count).toFixed(2);

			const langCode = channelLanguage.get(x.g)?.lang;
			const flag = flags[i] || "🌐";
			const langPart = langCode ? `${langCode} ${flag}` : "";

			return `${i + 1}. #${gPadded} — ${mpm}/mpm (${secs}s)` + (langPart ? ` ${langPart}` : "");
		});

		const users = activeUserCount();
		const msg = "top channels:\n" + lines.join("\n") + `\n\nactive users: ${users}`;
		reply(msg, geo);
	}

	// !listen: recent chat. bare = other channels; <lang> = a detected language;
	// otherwise treat the arg as a #geohash. (a leading # is optional.)
	function cmdListen(geo, args) {
		const target = args.length >= 1 ? String(args[0] || "").trim().toLowerCase().replace(/^#/, "") : "";
		let msg;
		if (!target) msg = buildListenOutput(geo, LISTEN_SHOW);
		else if (recentByLanguage.has(target)) msg = buildListenOutputForLanguage(target, LISTEN_SHOW);
		else msg = buildListenOutputForChannel(target, LISTEN_SHOW);
		reply(msg, geo);
	}

	// !help: generated from the registry, so a new command shows up here for free.
	// !help <command> prints that command's usage (its own metadata, not a blob).
	function cmdHelp(geo, arg) {
		const q = String(arg || "").trim().toLowerCase().replace(/^!/, "");
		if (q) {
			const c = byToken.get(q);
			if (c) {
				const aliasStr = c.aliases?.length ? ` (alias: ${c.aliases.map((a) => "!" + a).join(", ")})` : "";
				reply(`!${c.name} - ${c.usage || c.desc}${aliasStr}`, geo);
				return;
			}
		}
		const width = Math.max(...COMMANDS.map((c) => c.name.length + 1)); // +1 for the "!"
		const lines = [...COMMANDS]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((c) => `${("!" + c.name).padEnd(width)} - ${c.desc}`);
		reply("available commands:\n" + lines.join("\n") + "\n\n(use '!help <command>' for usage)", geo);
	}

	// the command registry: adding an entry here makes a command parse, dispatch,
	// AND appear in !help automatically - there's no static list to keep in sync.
	// aliases are the bang-stripped forms users learned (!t, !l, !list, !dump…).
	const COMMANDS = [
		{ name: "top", aliases: ["t"], desc: "list the most active chats", usage: "!top", run: (c) => cmdTop(c.geo) },
		{
			name: "listen",
			aliases: ["l", "list", "dump"],
			desc: "recent messages (+ <lang> or <#geohash>)",
			usage: "!listen | !listen <lang> | !listen <#geohash>",
			run: (c) => cmdListen(c.geo, c.args),
		},
		{ name: "help", aliases: ["h", "commands"], desc: "list commands", usage: "!help | !help <command>", run: (c) => cmdHelp(c.geo, c.args[0]) },
	];

	// name/alias -> command, built once from the registry above.
	const byToken = new Map();
	for (const c of COMMANDS) {
		byToken.set(c.name, c);
		for (const a of c.aliases || []) byToken.set(a, c);
	}

	// content -> { command, name, args } for a `!command` (command null if the token
	// isn't one of ours), or null when it isn't a command at all.
	function parseCommand(raw) {
		const original = String(raw ?? "").trim();
		if (!original.toLowerCase().startsWith("!")) return null;
		const parts = original.split(/\s+/);
		const token = parts[0].slice(1).toLowerCase(); // "!ToP" -> "top"
		return { command: byToken.get(token) || null, name: token, args: parts.slice(1) };
	}

	// global rate budget shared across every command/channel (anti-abuse).
	function commandCooldownOk() {
		const nowMs = Date.now();
		const cutoff = nowMs - COMMAND_COOLDOWN_WINDOW_MS;
		while (commandHits.length && commandHits[0] < cutoff) commandHits.shift();
		if (commandHits.length >= COMMAND_COOLDOWN_MAX) return false;
		commandHits.push(nowMs);
		return true;
	}

	// run a resolved command; tolerates sync + async handlers.
	function dispatch(parsed, geo) {
		const c = parsed.command;
		if (!c) return false;
		Promise.resolve(c.run({ geo, args: parsed.args })).catch((e) => console.error(`[bot] !${c.name} failed:`, e.message));
		return true;
	}

	// --- ingest hook ---------------------------------------------------------
	// called by the aggregator for each accepted LIVE chat event. Records activity
	// + language for every real message, and serves any `!command`. Backlog replays
	// (live=false) are never passed here, so the bot never answers stale history or
	// double-counts a relay's stored backlog.
	function observe(ev, geo) {
		if (!ev || ev.kind !== CHAT_KIND || !geo) return;
		if (ev.pubkey === pk) return; // never react to / count our own replies

		const content = String(ev.content || "");

		// language + presence tracking happen for every message (commands included,
		// exactly as before - a "!top" is too short for franc to latch onto anyway).
		updateChannelLanguage(geo, content);
		noteActivePubkey(ev.pubkey, ev.created_at);

		const parsed = parseCommand(content);
		if (parsed) {
			// any "!"-prefixed message is a command attempt - never counted as chat.
			if (!parsed.command) {
				console.log(`[bot] saw !${parsed.name} in #${geo} (unknown - no handler)`);
				return;
			}
			console.log(`[bot] saw !${parsed.name} in #${geo} from ${ev.pubkey.slice(0, 8)}`);
			if (!commandCooldownOk()) {
				console.log(`[bot] !${parsed.name} dropped (global cooldown)`);
				return; // global budget spent
			}
			dispatch(parsed, geo);
			return; // a command isn't itself "channel activity"
		}

		// real chat: feed the !top score + the !listen buffers
		if (content) {
			recordChannelActivity(geo, ev.created_at);
			pushRecent(ev, geo, content);
			rememberMessageLanguage(geo, nameOf(ev), content, ev.created_at);
		}
	}

	function stats() {
		return {
			pubkey: pk,
			name: botName,
			commands: COMMANDS.map((c) => c.name),
			trackedChannels: channelActivity.size,
			activeUsers: activePubkeys.size,
			languages: channelLanguage.size,
			recentBuffered: recentOther.length,
		};
	}

	return { observe, stats, pubkey: pk };
}
