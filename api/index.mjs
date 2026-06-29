import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { openStore } from "./store.mjs";
import { startAggregator } from "./aggregator.mjs";

// The optional "server assist" API. Deliberately separate from the static file
// server (server/index.mjs) so its failure modes - a wedged relay pool, a full
// disk, a crash - can never stop the pure client from loading. It is read-only:
// it ingests signed events from relays into a store and serves history back. It
// never holds keys, never sends messages, and the client works fully without it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.API_PORT || 3001;
const DB_PATH = process.env.API_DB || path.join(__dirname, "glub-history.db");
const DEFAULT_LIMIT = 200;

const store = openStore(DB_PATH);

const app = express();

// read-only public data, so any origin may read it (a client may point at this
// api from a different host).
app.use((req, res, next) => {
	res.set("Access-Control-Allow-Origin", "*");
	res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
	if (req.method === "OPTIONS") return res.sendStatus(204);
	next();
});

// liveness + how much history we're holding; the client pings this to decide
// whether to lean on the api or fall back to pure relay subscription.
app.get("/api/health", (req, res) => {
	res.json({ ok: true, ...store.stats() });
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

app.listen(PORT, () => {
	console.log(`glub-chat api on http://localhost:${PORT} (db: ${DB_PATH})`);
});

startAggregator(store);
