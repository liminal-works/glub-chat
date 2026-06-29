import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { openStore } from "./store.mjs";
import { createAggregator } from "./aggregator.mjs";

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

const aggregator = createAggregator(store, { onStored: broadcast });

const app = express();

// read-only public data, so any origin may read it (a client may point at this
// api from a different host).
app.use((req, res, next) => {
	res.set("Access-Control-Allow-Origin", "*");
	res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
	if (req.method === "OPTIONS") return res.sendStatus(204);
	next();
});

// liveness + how much history we hold + how many relays we're watching; the
// client pings this to decide whether to lean on the api or fall back to relays,
// and to render the assist status indicator.
app.get("/api/health", (req, res) => {
	res.json({ ok: true, ...store.stats(), relays: aggregator.stats() });
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
