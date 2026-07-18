import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
// Optional: when the history api runs alongside the static site, forward /api/*
// to it so the client reaches it same-origin (no CORS, no per-deploy config).
// This is a transparent passthrough only - the api stays its own process, holds
// the keys/logic, and the static server keeps serving files even if it's down.
const API_ORIGIN = process.env.API_ORIGIN || (process.env.API_PORT ? `http://127.0.0.1:${process.env.API_PORT}` : "");

const app = express();

if (API_ORIGIN) {
	const target = new URL(API_ORIGIN);
	app.use("/api", (req, res) => {
		// stamp the real client address so the api's per-IP rate limits see
		// individual users instead of one shared 127.0.0.1 bucket. OVERWRITE any
		// inbound x-forwarded-for - this proxy is the only hop the api trusts, and
		// appending would let clients mint fresh rate buckets by rotating fake
		// addresses in the header.
		const proxyReq = http.request(
			{
				host: target.hostname,
				port: target.port,
				path: req.originalUrl, // includes /api/... and the query string
				method: req.method,
				headers: { ...req.headers, host: target.host, "x-forwarded-for": req.socket.remoteAddress },
			},
			(proxyRes) => {
				// stream the response straight through - keeps SSE (/api/stream) live
				res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
				proxyRes.pipe(res);
			}
		);
		proxyReq.on("error", () => {
			if (!res.headersSent) res.status(502).end();
		});
		req.pipe(proxyReq);
	});
	console.log(`proxying /api -> ${API_ORIGIN}`);
}

// html/js/css: no-cache means "revalidate every load" (cheap 304s via etag),
// never heuristic freshness - without this, browsers may serve a stale app.js
// for days after a deploy (ios standalone is especially sticky about it).
// images and other heavy assets can stay heuristically cached.
app.use(
	express.static(path.join(__dirname, "..", "public"), {
		setHeaders(res, filePath) {
			if (/\.(html|js|mjs|css)$/.test(filePath)) res.set("Cache-Control", "no-cache");
		},
	})
);

app.listen(PORT, () => {
	console.log(`glub-chat running on http://localhost:${PORT}`);
});
