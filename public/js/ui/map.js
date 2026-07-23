// A hand-rolled map for browsing geohash channels, in two seamlessly blended
// projections. Pure canvas 2D - no three.js, no leaflet, no webgl.
//
// Zoomed out it's the wireframe globe: orthographic projection, sphere limb,
// vendored coastlines, day/night terminator, geohash grid at a zoom-derived
// depth. Zoom past the blend band and it cross-fades into a flat web-mercator
// street view - raster tiles (the same Carto basemap native bitchat-android
// ships) under the same geohash grid, down to street-level precisions the globe
// could never enumerate. The scales are matched at the crossing, so the grid
// just "flattens" underfoot. Both modes share the overlays: activity glow, live
// pings, "here" counts, hover/tap-to-join.
//
// createMap({ canvas, onPick, colors }) -> { open, close, setActivity, ping, ... }
// colors: () => ({ accent, fg, muted, bg }) so the map follows the theme.

import { COASTLINES } from "./coastlines.js";

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const NIGHT_ALPHA = 0.58; // how dark the night hemisphere shade sits over the land
const NIGHT_SHADE = "#03060c"; // near-black blue the night side dims toward
const TWILIGHT_BAND = 0.16; // half-width (in surface-normal dot units) of the soft dawn/dusk falloff
const NIGHT_GRID_DIM = 0.78; // how much a deep-night cell's outline/label fades (0 = none, 1 = gone)

// --- globe -> flat street-map handoff ---------------------------------------
const FLAT_LO = 26; // below this zoom the view is pure globe
const FLAT_HI = 34; // above it, pure flat map; in between the two cross-fade
const FLAT_MAX_DEPTH = 12; // flat grid enumerates to full geohash precision (viewport-bounded, so it's cheap)
const MERC_LAT_MAX = 85.0511; // web-mercator's latitude limit
const TILE_SIZE = 256;
const TILE_MAX_Z = 19; // deepest tile level requested; zooming past it stretches tiles rather than 404ing
const TILE_CACHE_MAX = 300;
// the same basemap family native bitchat-android's picker uses (theirs is
// light_all; dark_all matches our terminal look). override with
// window.GLUB_TILE_URL - a custom template, or "" to disable tiles entirely
// (the flat view then stays grid-only, which is also the offline behavior).
const TILE_URL_DEFAULT = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";

// --- geohash math (self-contained; map owns its own encode/decode) -----------

// bit split for a given length: longitude gets ceil(5L/2) bits, latitude the rest.
function bitsFor(len) {
	const total = len * 5;
	return { lon: Math.ceil(total / 2), lat: Math.floor(total / 2) };
}

// encode a lat/lon to a geohash of the given length
function encodeGeohash(lat, lon, len) {
	let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
	let even = true, bit = 0, ch = 0, out = "";
	while (out.length < len) {
		if (even) {
			const mid = (lonLo + lonHi) / 2;
			if (lon >= mid) { ch = (ch << 1) | 1; lonLo = mid; } else { ch <<= 1; lonHi = mid; }
		} else {
			const mid = (latLo + latHi) / 2;
			if (lat >= mid) { ch = (ch << 1) | 1; latLo = mid; } else { ch <<= 1; latHi = mid; }
		}
		even = !even;
		if (++bit === 5) { out += GEOHASH_BASE32[ch]; bit = 0; ch = 0; }
	}
	return out;
}

// cell bounds { latLo, latHi, lonLo, lonHi } for a geohash string
function geohashBounds(gh) {
	let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180, even = true;
	for (const c of gh) {
		const idx = GEOHASH_BASE32.indexOf(c);
		for (let b = 4; b >= 0; b--) {
			const v = (idx >> b) & 1;
			if (even) { const m = (lonLo + lonHi) / 2; v ? (lonLo = m) : (lonHi = m); }
			else { const m = (latLo + latHi) / 2; v ? (latLo = m) : (latHi = m); }
			even = !even;
		}
	}
	return { latLo, latHi, lonLo, lonHi };
}

export function createMap({ canvas, onPick, colors }) {
	const ctx = canvas.getContext("2d");
	let W = 0, H = 0, cx = 0, cy = 0, dpr = 1;

	// view state: center lon/lat (yaw/pitch) + zoom (1 = globe fits the frame).
	// zoom is one continuous axis across both projections: the globe carries it to
	// the blend band, the flat map onward (its cap comes from tile depth, see
	// maxZoom). ZOOM_MAX is gone on purpose.
	let yaw = -20, pitch = 18, zoom = 1;
	const ZOOM_MIN = 1;
	let activity = new Map(); // full-geohash -> intensity 0..1
	let counts = new Map(); // full-geohash -> distinct talkers "here" (last few min)
	let pings = []; // { lon, lat, born } expanding ripples where a message just landed
	const PING_MS = 1700; // a ping's ripple lives this long, then it's pruned
	let raf = null, running = false;
	let lastInteract = 0;
	let hoverGeo = null; // cell under the pointer (for the label/pick affordance)
	// cos(latitude) captured as the view crosses into the flat blend: it pins the
	// mercator world size so one degree of longitude spans the same pixels in both
	// projections at the handoff - that scale match IS the seamlessness. cleared
	// once the view is fully back on the globe.
	let flatCosLat = null;
	const tiles = new Map(); // "z/x/y" -> { img, ok }
	const tileUrl = () =>
		typeof window !== "undefined" && window.GLUB_TILE_URL !== undefined ? window.GLUB_TILE_URL : TILE_URL_DEFAULT;

	function resize() {
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		const r = canvas.getBoundingClientRect();
		W = Math.max(1, Math.round(r.width));
		H = Math.max(1, Math.round(r.height));
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		cx = W / 2;
		cy = H / 2;
	}

	// base globe radius so it fits with margin; zoom scales it up
	function radius() {
		return Math.min(W, H) * 0.42 * zoom;
	}

	// project a lon/lat (deg) to screen. returns { x, y, front } - front=false
	// means it's on the far hemisphere (caller skips or clips it).
	const sinP = () => Math.sin(pitch * DEG);
	const cosP = () => Math.cos(pitch * DEG);
	function project(lon, lat, R, sp, cp) {
		const l = (lon - yaw) * DEG;
		const p = lat * DEG;
		const cl = Math.cos(p);
		const x = cl * Math.sin(l);
		const y = Math.sin(p);
		const z = cl * Math.cos(l);
		// pitch rotation about the screen x-axis
		const yr = y * cp - z * sp;
		const zr = y * sp + z * cp;
		return { x: cx + R * x, y: cy - R * yr, front: zr > 0 };
	}

	// on-screen size (px) of a depth-L cell near the view center - drives which
	// depth to draw and whether a cell is big enough to label.
	function cellPx(len, R) {
		const { lon } = bitsFor(len);
		const wDeg = 360 / 2 ** lon;
		return R * wDeg * DEG;
	}

	// pick the geohash depth whose cells read at a comfortable on-screen size;
	// deeper as you zoom in. capped so we never enumerate an absurd grid.
	function depthFor(R) {
		let best = 1;
		for (let len = 1; len <= 8; len++) {
			if (cellPx(len, R) >= 46) best = len;
			else break;
		}
		return best;
	}

	// lat/lon window currently visible, so we only enumerate nearby cells. at low
	// zoom this is the whole globe; zoomed in it's a small patch around center.
	function visibleWindow(R) {
		// half-angle of the visible cap grows as zoom shrinks; ~90deg at zoom 1
		const half = Math.min(90, 80 / zoom + 6);
		const latLo = Math.max(-90, pitch - half);
		const latHi = Math.min(90, pitch + half);
		// longitude span widens near the poles; clamp to full wrap when broad
		const lonHalf = Math.min(180, half / Math.max(0.15, Math.cos(pitch * DEG)));
		return { latLo, latHi, lonLo: yaw - lonHalf, lonHi: yaw + lonHalf, full: lonHalf >= 179 };
	}

	// --- flat (web-mercator) mode ----------------------------------------------

	// blend factor: 0 = pure globe, 1 = pure flat, smoothstepped across the band.
	function flatT() {
		const t = Math.max(0, Math.min(1, (zoom - FLAT_LO) / (FLAT_HI - FLAT_LO)));
		return t * t * (3 - 2 * t);
	}

	// mercator world width in px for the current zoom. derived from the globe's
	// px-per-longitude-degree at the captured latitude, so the two projections
	// agree on scale through the whole blend band.
	function worldPx() {
		if (flatCosLat == null) flatCosLat = Math.cos(pitch * DEG);
		return radius() * flatCosLat * DEG * 360;
	}

	// flat projection: x is linear in longitude (wrapped around the view center so
	// the antimeridian never splits the viewport), y is mercator in latitude.
	function xFromLon(lon, wpx = worldPx()) {
		return cx + wrapLon(lon - yaw) * (wpx / 360);
	}
	function yFromLat(lat, wpx = worldPx()) {
		return cy + (mercY01(lat) - mercY01(pitch)) * wpx;
	}
	function lonFromX(px, wpx = worldPx()) {
		return wrapLon(yaw + ((px - cx) * 360) / wpx);
	}
	function latFromY(py, wpx = worldPx()) {
		return invMercY01(mercY01(pitch) + (py - cy) / wpx);
	}

	// deepest geohash depth whose cells read comfortably at this world size. the
	// flat viewport bounds enumeration by construction, so full precision is fine.
	function flatDepthFor(wpx) {
		let best = 1;
		for (let len = 1; len <= FLAT_MAX_DEPTH; len++) {
			const wDeg = 360 / 2 ** bitsFor(len).lon;
			if ((wpx * wDeg) / 360 >= 46) best = len;
			else break;
		}
		return best;
	}

	// zoom cap: irrelevant on the globe (the blend takes over long before), and in
	// flat mode set where the deepest tiles would be stretched ~2x - street level.
	function maxZoom() {
		if (flatCosLat == null) return 90;
		const maxWorld = TILE_SIZE * 2 ** (TILE_MAX_Z + 1);
		return maxWorld / (Math.min(W, H) * 0.42 * flatCosLat * DEG * 360);
	}

	// mode-aware projection for the shared overlays (pings, on-screen checks):
	// the flat projector once the blend is past halfway, the globe one before.
	function projectPoint(lon, lat) {
		if (flatT() >= 0.5) return { x: xFromLon(lon), y: yFromLat(lat), front: true };
		return project(lon, lat, radius(), sinP(), cosP());
	}

	// --- drawing ---------------------------------------------------------------

	// orchestrator: cross-fades the globe and the flat street map through the
	// blend band, then draws the mode-agnostic overlays (pings) on top.
	function draw() {
		const c = colors();
		ctx.clearRect(0, 0, W, H);
		if (zoom <= FLAT_LO) flatCosLat = null; // fully on the globe again: re-derive the scale match at the next crossing
		const t = flatT();
		if (t < 1) {
			ctx.save();
			if (t > 0) ctx.globalAlpha = 1 - t;
			drawGlobe(c);
			ctx.restore();
		}
		if (t > 0) {
			ctx.save();
			if (t < 1) ctx.globalAlpha = t;
			drawFlat(c);
			ctx.restore();
		}
		drawPings(c);
	}

	function drawGlobe(c) {
		const R = radius();
		const sp = sinP(), cp = cosP();

		// sphere disc (subtle fill) + limb
		ctx.beginPath();
		ctx.arc(cx, cy, R, 0, TWO_PI);
		ctx.fillStyle = withAlpha(c.accent, 0.04);
		ctx.fill();
		ctx.lineWidth = 1.2;
		ctx.strokeStyle = withAlpha(c.accent, 0.5);
		ctx.stroke();

		// clip everything else to the disc so far-side bleed never shows
		ctx.save();
		ctx.beginPath();
		ctx.arc(cx, cy, R, 0, TWO_PI);
		ctx.clip();

		// subsolar direction in view space, computed once and shared: it darkens the
		// night hemisphere AND fades each night-side geohash cell (see drawCell).
		const sun = subsolarPoint();
		const sunVec = viewVec(sun.lon, sun.lat, sp, cp);

		drawGraticule(R, sp, cp, withAlpha(c.accent, 0.1));
		drawCoastlines(R, sp, cp, withAlpha(c.fg, 0.32));

		// twilight: shade the night hemisphere, with a soft glowing rim along the
		// terminator. drawn before the grid so the land/ocean dim underneath.
		drawNight(R, sp, cp, sunVec, c);

		const depth = depthFor(R);
		drawGeohashGrid(R, sp, cp, depth, c, sunVec);

		ctx.restore();
	}

	// --- flat rendering: tiles, veil, grid, attribution --------------------------

	function drawFlat(c) {
		const wpx = worldPx();
		drawTiles(wpx);
		// theme veil: sit the street tiles inside the terminal palette instead of
		// letting a foreign basemap glare through. also what the grid draws over.
		ctx.fillStyle = withAlpha(c.bg, 0.22);
		ctx.fillRect(0, 0, W, H);
		// same day/night pass the globe runs: shade the night side and fade its grid
		// cells, so the two projections carry an identical terminator through the blend.
		const sun = subsolarPoint();
		drawFlatNight(c, wpx, sun);
		drawFlatGrid(c, wpx, sun);
		drawAttribution(c);
	}

	// flat-projection twin of drawNight: sample the terminator latitude across the
	// visible width, then flood the night side of that curve with the same shade the
	// globe uses. the per-column termLat = atan(-C/S) stays correct straight through
	// the equinox (S->0 sends day columns' fill off one screen edge, night columns'
	// off the other), so no special-casing beyond guarding the divide.
	function drawFlatNight(c, wpx, sun) {
		const S = Math.sin(sun.lat * DEG);
		const Sd = Math.abs(S) < 1e-6 ? (S < 0 ? -1e-6 : 1e-6) : S;
		const nightUp = S < 0; // subsolar point south -> night pole is north (upper screen)
		const cosSun = Math.cos(sun.lat * DEG);
		const pts = [];
		for (let px = 0; px <= W; px += 6) {
			const lon = lonFromX(px, wpx);
			const C = cosSun * Math.cos((lon - sun.lon) * DEG);
			let termLat = Math.atan(-C / Sd) / DEG;
			termLat = Math.max(-MERC_LAT_MAX, Math.min(MERC_LAT_MAX, termLat));
			const y = Math.max(-1, Math.min(H + 1, yFromLat(termLat, wpx)));
			pts.push([px, y]);
		}
		const edgeY = nightUp ? -1 : H + 1;
		ctx.beginPath();
		ctx.moveTo(pts[0][0], pts[0][1]);
		for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
		ctx.lineTo(W, edgeY);
		ctx.lineTo(0, edgeY);
		ctx.closePath();
		ctx.fillStyle = withAlpha(NIGHT_SHADE, NIGHT_ALPHA);
		ctx.fill();

		// twilight rim: trace just the terminator so the boundary reads as a lit edge.
		ctx.beginPath();
		ctx.moveTo(pts[0][0], pts[0][1]);
		for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
		ctx.strokeStyle = withAlpha(c.accent, 0.5);
		ctx.lineWidth = 1.4;
		ctx.stroke();
	}

	// projection-independent twin of nightFactor: 0 in full daylight, 1 in deep
	// night, with the same TWILIGHT_BAND ramp. d is the sun-elevation cosine at the
	// point, so it needs no view-space rotation and works for the flat grid.
	function flatNightFactor(lat, lon, sun) {
		const la = lat * DEG, lo = lon * DEG;
		const sla = sun.lat * DEG, slo = sun.lon * DEG;
		const d = Math.sin(la) * Math.sin(sla) + Math.cos(la) * Math.cos(sla) * Math.cos(lo - slo);
		return Math.max(0, Math.min(1, 0.5 - d / (2 * TWILIGHT_BAND)));
	}

	// fetch-and-cache one tile; a tile that errors just stays blank (the grid-only
	// view is the graceful offline/blocked fallback, never a broken map).
	function tileFor(z, xw, y) {
		const key = `${z}/${xw}/${y}`;
		let t = tiles.get(key);
		if (t) return t;
		const template = tileUrl();
		if (!template) return null;
		if (tiles.size >= TILE_CACHE_MAX) tiles.clear(); // crude but bounded; visible tiles refill fast from the http cache
		t = { img: new Image(), ok: false };
		t.img.crossOrigin = "anonymous";
		t.img.onload = () => { t.ok = true; };
		t.img.onerror = () => {};
		t.img.src = template
			.replace("{s}", "abcd"[(xw + y) % 4])
			.replace("{z}", z)
			.replace("{x}", xw)
			.replace("{y}", y);
		tiles.set(key, t);
		return t;
	}

	function drawTiles(wpx) {
		if (!tileUrl()) return;
		const z = Math.max(0, Math.min(TILE_MAX_Z, Math.floor(Math.log2(wpx / TILE_SIZE))));
		const n = 2 ** z;
		const tpx = wpx / n; // on-screen size of one tile
		const txC = ((yaw + 180) / 360) * n; // fractional tile coords of the view center
		const tyC = mercY01(pitch) * n;
		const tx0 = Math.floor(txC - cx / tpx);
		const tx1 = Math.ceil(txC + (W - cx) / tpx);
		const ty0 = Math.max(0, Math.floor(tyC - cy / tpx));
		const ty1 = Math.min(n - 1, Math.ceil(tyC + (H - cy) / tpx));
		for (let ty = ty0; ty <= ty1; ty++) {
			for (let tx = tx0; tx <= tx1; tx++) {
				const xw = ((tx % n) + n) % n; // wrap across the antimeridian
				const t = tileFor(z, xw, ty);
				if (!t || !t.ok) continue;
				// the +0.5 overdraw hides hairline seams between neighboring tiles
				ctx.drawImage(t.img, cx + (tx - txC) * tpx, cy + (ty - tyC) * tpx, tpx + 0.5, tpx + 0.5);
			}
		}
	}

	// carto's tile terms require attribution; shown whenever the street layer is.
	function drawAttribution(c) {
		if (!tileUrl()) return;
		ctx.font = "9px ui-monospace, monospace";
		ctx.textAlign = "right";
		ctx.textBaseline = "bottom";
		ctx.fillStyle = withAlpha(c.muted, 0.9);
		ctx.fillText("© openstreetmap · © carto", W - 6, H - 5);
	}

	// the same grid the globe draws, enumerated straight from the flat viewport -
	// which is what finally lifts the old depth-3 ceiling: only visible cells are
	// walked, so street-level precisions cost the same as continental ones.
	function drawFlatGrid(c, wpx, sun) {
		const depth = flatDepthFor(wpx);
		const { lat: latBits, lon: lonBits } = bitsFor(depth);
		const latStep = 180 / 2 ** latBits;
		const lonStep = 360 / 2 ** lonBits;

		// same activity/count rollups the globe grid uses
		const act = new Map();
		for (const [gh, inten] of activity) {
			if (gh.length < depth) continue;
			const key = gh.slice(0, depth);
			act.set(key, Math.max(act.get(key) || 0, inten));
		}
		const cnt = new Map();
		for (const [gh, n] of counts) {
			if (gh.length < depth) continue;
			const key = gh.slice(0, depth);
			cnt.set(key, (cnt.get(key) || 0) + n);
		}

		const label = (wpx * lonStep) / 360 >= 58;
		const latHi = Math.min(MERC_LAT_MAX, latFromY(0, wpx));
		const latLo = Math.max(-MERC_LAT_MAX, latFromY(H, wpx));
		const lonHalfSpan = Math.min(180, (W * 360) / (2 * wpx));
		const latStart = Math.floor((latLo + 90) / latStep) * latStep - 90;
		const lonStart = Math.floor((yaw - lonHalfSpan + 180) / lonStep) * lonStep - 180;
		const lonEnd = yaw + lonHalfSpan;
		let drawn = 0;
		for (let lat = latStart; lat <= latHi && lat < 90; lat += latStep) {
			for (let lon = lonStart; lon < lonEnd; lon += lonStep) {
				if (drawn++ > 900) return;
				const clat = lat + latStep / 2;
				const clon = wrapLon(lon + lonStep / 2);
				const gh = encodeGeohash(clat, clon, depth);
				drawFlatCell(gh, c, act.get(gh) || 0, label, cnt.get(gh) || 0, wpx, sun);
			}
		}
	}

	// one grid cell in the flat view: geohash cells are lat/lon-aligned, so in
	// mercator they're plain axis-aligned rectangles. styling mirrors drawCell
	// (activity fill, hover, label + accent count), night dim and all.
	function drawFlatCell(gh, c, intensity, label, count, wpx, sun) {
		const b = geohashBounds(gh);
		const x0 = xFromLon(b.lonLo, wpx);
		const x1 = x0 + ((b.lonHi - b.lonLo) * wpx) / 360; // width, not a second wrap - dodges antimeridian flips
		const y0 = yFromLat(b.latHi, wpx);
		const y1 = yFromLat(b.latLo, wpx);
		if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) return;

		const hovered = gh === hoverGeo;
		// night fades only the "structural" cells - active, counted, or hovered cells
		// stay full strength so talkers and the pointer always read (mirrors drawCell).
		const night = sun ? flatNightFactor((b.latLo + b.latHi) / 2, (b.lonLo + b.lonHi) / 2, sun) : 0;
		const dim = hovered || intensity > 0 || count > 0 ? 1 : 1 - NIGHT_GRID_DIM * night;
		ctx.beginPath();
		ctx.rect(x0, y0, x1 - x0, y1 - y0);
		if (intensity > 0) {
			ctx.fillStyle = withAlpha(c.accent, 0.1 + 0.32 * intensity);
			ctx.fill();
		} else if (hovered) {
			ctx.fillStyle = withAlpha(c.accent, 0.14);
			ctx.fill();
		}
		ctx.lineWidth = hovered ? 1.6 : intensity > 0 ? 1.2 : 0.8;
		ctx.strokeStyle = withAlpha(c.accent, (hovered ? 0.95 : 0.28 + 0.5 * intensity) * dim);
		ctx.stroke();

		if (label || hovered) {
			const mx = (x0 + x1) / 2;
			const my = (y0 + y1) / 2;
			ctx.font = `${hovered ? 13 : 11}px ui-monospace, monospace`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillStyle = withAlpha(c.fg, (hovered ? 1 : 0.8) * dim);
			if (count > 0) {
				const name = "#" + gh;
				const suffix = "  " + count;
				const nameW = ctx.measureText(name).width;
				const sufW = ctx.measureText(suffix).width;
				const left = mx - (nameW + sufW) / 2;
				ctx.textAlign = "left";
				ctx.fillText(name, left, my);
				ctx.fillStyle = withAlpha(c.accent, hovered ? 1 : 0.9);
				ctx.fillText(suffix, left + nameW, my);
			} else {
				ctx.fillText("#" + gh, mx, my);
			}
		}
	}

	// --- day/night terminator ----------------------------------------------------

	// subsolar point (lat/lon in degrees) for a given time: where the sun is
	// directly overhead. declination from a standard day-of-year approximation;
	// longitude straight from UTC (noon over Greenwich, drifting west with the
	// clock). the small equation-of-time wobble (<=~4deg) is left out - this is
	// ambient shading, not an almanac.
	function subsolarPoint(now = new Date()) {
		const start = Date.UTC(now.getUTCFullYear(), 0, 0);
		const dayMs = 86400000;
		const dayOfYear = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start) / dayMs;
		const decl = 23.44 * Math.sin(((360 / 365) * (dayOfYear - 81)) * DEG);
		const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
		const lon = wrapLon(180 - 15 * utcHours);
		return { lat: decl, lon };
	}

	// rotate a lon/lat (deg) into view space (same frame project() works in): the
	// unit vector whose z>0 means front-facing. returns { x, y, z }.
	function viewVec(lon, lat, sp, cp) {
		const l = (lon - yaw) * DEG;
		const p = lat * DEG;
		const cl = Math.cos(p);
		const x = cl * Math.sin(l);
		const y0 = Math.sin(p);
		const z0 = cl * Math.cos(l);
		return { x, y: y0 * cp - z0 * sp, z: y0 * sp + z0 * cp };
	}

	// fill the visible night lune with a translucent shade. the terminator is the
	// great circle 90deg from the subsolar point; in orthographic projection its
	// front-facing arc is one contiguous curve that meets the disc limb at two
	// points. we stitch that arc to the night stretch of the limb and fill the
	// enclosed region. degenerate cases (sun dead-center / behind) fall back to no
	// shade / full shade.
	function drawNight(R, sp, cp, s, c) {
		if (s.z >= 0.999) return; // sun straight at us -> no visible night
		if (s.z <= -0.999) {
			// sun behind the globe -> the whole visible face is night
			ctx.beginPath();
			ctx.arc(cx, cy, R, 0, TWO_PI);
			ctx.fillStyle = withAlpha(NIGHT_SHADE, NIGHT_ALPHA);
			ctx.fill();
			return;
		}

		// orthonormal basis (u, v) spanning the terminator plane (both perpendicular
		// to s), so p(t) = cos t * u + sin t * v traces the terminator great circle.
		const ref = Math.abs(s.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
		let u = cross(s, ref);
		u = norm(u);
		const v = cross(s, u); // already unit (s, u orthonormal)

		// sample the terminator; keep the contiguous front-facing arc, in order.
		const N = 240;
		const pts = [];
		for (let i = 0; i < N; i++) {
			const t = (i / N) * TWO_PI;
			const ct = Math.cos(t), st = Math.sin(t);
			const P = { x: ct * u.x + st * v.x, y: ct * u.y + st * v.y, z: ct * u.z + st * v.z };
			pts.push({ x: cx + R * P.x, y: cy - R * P.y, front: P.z > 0 });
		}
		// rotate the ring so index 0 is the first back->front transition, making the
		// front run contiguous (no wraparound to special-case).
		let startIdx = -1;
		for (let i = 0; i < N; i++) {
			if (pts[i].front && !pts[(i - 1 + N) % N].front) { startIdx = i; break; }
		}
		if (startIdx < 0) return; // no clean transition (grazing); skip shading this frame
		const arc = [];
		for (let k = 0; k < N; k++) {
			const p = pts[(startIdx + k) % N];
			if (!p.front) break;
			arc.push(p);
		}
		if (arc.length < 2) return;

		// the arc's endpoints sit on the limb; close the region across the night
		// stretch of the limb between them. pick the limb direction whose midpoint
		// is on the night side (view-space dot with s < 0).
		const a0 = Math.atan2(arc[arc.length - 1].y - cy, arc[arc.length - 1].x - cx);
		const a1 = Math.atan2(arc[0].y - cy, arc[0].x - cx);
		const nightAt = (ang) => Math.cos(ang) * s.x - Math.sin(ang) * s.y < 0; // limb point . s
		let mid = a0 + angDelta(a0, a1) / 2;
		let delta = angDelta(a0, a1);
		if (!nightAt(mid)) { delta = delta - Math.sign(delta || 1) * TWO_PI; mid = a0 + delta / 2; }

		ctx.beginPath();
		ctx.moveTo(arc[0].x, arc[0].y);
		for (let i = 1; i < arc.length; i++) ctx.lineTo(arc[i].x, arc[i].y);
		const steps = 48;
		for (let i = 1; i <= steps; i++) {
			const ang = a0 + (delta * i) / steps;
			ctx.lineTo(cx + R * Math.cos(ang), cy + R * Math.sin(ang));
		}
		ctx.closePath();
		ctx.fillStyle = withAlpha(NIGHT_SHADE, NIGHT_ALPHA);
		ctx.fill();

		// twilight rim: trace just the terminator arc with a soft accent glow so the
		// day/night boundary reads as a lit edge, not just a shadow.
		ctx.beginPath();
		ctx.moveTo(arc[0].x, arc[0].y);
		for (let i = 1; i < arc.length; i++) ctx.lineTo(arc[i].x, arc[i].y);
		ctx.strokeStyle = withAlpha(c.accent, 0.5);
		ctx.lineWidth = 1.4;
		ctx.stroke();
	}

	// how deep in night a surface point is: 0 in full daylight, 1 in deep night,
	// with a soft TWILIGHT_BAND-wide ramp across the terminator. `vv` is the point's
	// view-space unit vector; `s` the subsolar one (their dot is the sun elevation).
	function nightFactor(vv, s) {
		const d = vv.x * s.x + vv.y * s.y + vv.z * s.z;
		return Math.max(0, Math.min(1, 0.5 - d / (2 * TWILIGHT_BAND)));
	}

	function drawGraticule(R, sp, cp, style) {
		ctx.strokeStyle = style;
		ctx.lineWidth = 0.6;
		for (let lat = -60; lat <= 60; lat += 30) strokePath(latLine(lat), R, sp, cp);
		for (let lon = -180; lon < 180; lon += 30) strokePath(lonLine(lon), R, sp, cp);
	}

	function latLine(lat) {
		const pts = [];
		for (let lon = -180; lon <= 180; lon += 4) pts.push([lon, lat]);
		return pts;
	}
	function lonLine(lon) {
		const pts = [];
		for (let lat = -90; lat <= 90; lat += 4) pts.push([lon, lat]);
		return pts;
	}

	function drawCoastlines(R, sp, cp, style) {
		ctx.strokeStyle = style;
		ctx.lineWidth = 0.9;
		for (const ring of COASTLINES) {
			ctx.beginPath();
			let pen = false;
			for (let i = 0; i < ring.length; i += 2) {
				const p = project(ring[i], ring[i + 1], R, sp, cp);
				if (!p.front) { pen = false; continue; } // break the stroke across the limb
				if (pen) ctx.lineTo(p.x, p.y);
				else { ctx.moveTo(p.x, p.y); pen = true; }
			}
			ctx.stroke();
		}
	}

	// enumerate + draw the visible geohash cells at `depth`; glow active ones.
	function drawGeohashGrid(R, sp, cp, depth, c, sunVec) {
		const { lat: latBits, lon: lonBits } = bitsFor(depth);
		const latStep = 180 / 2 ** latBits;
		const lonStep = 360 / 2 ** lonBits;
		const win = visibleWindow(R);

		// prefix -> intensity for the current depth (activity is on full geohashes)
		const act = new Map();
		for (const [gh, inten] of activity) {
			if (gh.length < depth) continue;
			const key = gh.slice(0, depth);
			act.set(key, Math.max(act.get(key) || 0, inten));
		}
		// prefix -> summed talkers for the current depth (a region shows the people
		// across all its child cells)
		const cnt = new Map();
		for (const [gh, n] of counts) {
			if (gh.length < depth) continue;
			const key = gh.slice(0, depth);
			cnt.set(key, (cnt.get(key) || 0) + n);
		}

		const px = cellPx(depth, R);
		const label = px >= 58;
		const seen = new Set();
		let drawn = 0;

		const latStart = Math.floor((win.latLo + 90) / latStep) * latStep - 90;
		for (let lat = latStart; lat <= win.latHi && lat < 90; lat += latStep) {
			const lonStart = win.full ? -180 : Math.floor((win.lonLo + 180) / lonStep) * lonStep - 180;
			const lonEnd = win.full ? 180 : win.lonHi;
			for (let lon = lonStart; lon < lonEnd; lon += lonStep) {
				if (drawn > 900) break;
				const clat = lat + latStep / 2;
				const clon = wrapLon(lon + lonStep / 2);
				// cheap front test on the center before doing corner work
				const cprj = project(clon, clat, R, sp, cp);
				if (!cprj.front) continue;
				const gh = encodeGeohash(clat, clon, depth);
				if (seen.has(gh)) continue;
				seen.add(gh);
				drawn++;
				// fade the cell toward night by where its center sits vs the sun
				const nf = sunVec ? nightFactor(viewVec(clon, clat, sp, cp), sunVec) : 0;
				drawCell(gh, R, sp, cp, c, act.get(gh) || 0, label, cprj, cnt.get(gh) || 0, nf);
			}
		}
	}

	function drawCell(gh, R, sp, cp, c, intensity, label, center, count, night = 0) {
		const b = geohashBounds(gh);
		// subdivide each edge so cells curve with the sphere
		const path = [];
		const steps = 6;
		const edge = (a, bb) => {
			for (let i = 0; i < steps; i++) {
				const t = i / steps;
				path.push([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t]);
			}
		};
		edge([b.lonLo, b.latLo], [b.lonHi, b.latLo]);
		edge([b.lonHi, b.latLo], [b.lonHi, b.latHi]);
		edge([b.lonHi, b.latHi], [b.lonLo, b.latHi]);
		edge([b.lonLo, b.latHi], [b.lonLo, b.latLo]);

		let any = false, allFront = true;
		ctx.beginPath();
		for (let i = 0; i < path.length; i++) {
			const p = project(path[i][0], path[i][1], R, sp, cp);
			if (!p.front) { allFront = false; continue; }
			if (any) ctx.lineTo(p.x, p.y);
			else { ctx.moveTo(p.x, p.y); any = true; }
		}
		if (!any) return;
		if (allFront) ctx.closePath();

		const hovered = gh === hoverGeo;
		// night fades only the "structural" cells - an active, counted, or hovered
		// cell keeps full strength so talkers and the pointer always read, day or night.
		const dim = hovered || intensity > 0 || count > 0 ? 1 : 1 - NIGHT_GRID_DIM * night;
		if (intensity > 0) {
			ctx.fillStyle = withAlpha(c.accent, 0.1 + 0.32 * intensity);
			ctx.fill();
		} else if (hovered) {
			ctx.fillStyle = withAlpha(c.accent, 0.14);
			ctx.fill();
		}
		ctx.lineWidth = hovered ? 1.6 : intensity > 0 ? 1.2 : 0.8;
		ctx.strokeStyle = withAlpha(c.accent, (hovered ? 0.95 : 0.28 + 0.5 * intensity) * dim);
		ctx.stroke();

		if ((label || hovered) && center.front) {
			ctx.font = `${hovered ? 13 : 11}px ui-monospace, monospace`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillStyle = withAlpha(c.fg, (hovered ? 1 : 0.8) * dim);
			// append a live "here" count when this region has recent talkers, in the
			// accent so it reads as a separate signal from the geohash label itself.
			if (count > 0) {
				const name = "#" + gh;
				const suffix = "  " + count;
				const nameW = ctx.measureText(name).width;
				const sufW = ctx.measureText(suffix).width;
				const left = center.x - (nameW + sufW) / 2;
				ctx.textAlign = "left";
				ctx.fillText(name, left, center.y);
				ctx.fillStyle = withAlpha(c.accent, hovered ? 1 : 0.9);
				ctx.fillText(suffix, left + nameW, center.y);
			} else {
				ctx.fillText("#" + gh, center.x, center.y);
			}
		}
	}

	// expanding ripple(s) at each recent ping's cell center, fading over PING_MS.
	// mode-agnostic: drawn after both layers via the blended projector, so a ping
	// lands on the same spot whether that spot is on the sphere or the street map.
	function drawPings(c) {
		if (!pings.length) return;
		const now = performance.now();
		for (const p of pings) {
			const age = (now - p.born) / PING_MS;
			if (age >= 1) continue;
			const prj = projectPoint(p.lon, p.lat);
			if (!prj.front) continue;
			const ease = 1 - (1 - age) * (1 - age); // ease-out
			const rad = 3 + ease * 24;
			ctx.beginPath();
			ctx.arc(prj.x, prj.y, rad, 0, TWO_PI);
			ctx.lineWidth = 1.6 * (1 - age);
			ctx.strokeStyle = withAlpha(c.accent, 0.75 * (1 - age));
			ctx.stroke();
			// a bright core that fades faster, so the origin cell flashes
			if (age < 0.5) {
				ctx.beginPath();
				ctx.arc(prj.x, prj.y, 2.5, 0, TWO_PI);
				ctx.fillStyle = withAlpha(c.accent, 0.9 * (1 - age * 2));
				ctx.fill();
			}
		}
	}

	function strokePath(pts, R, sp, cp) {
		ctx.beginPath();
		let pen = false;
		for (const [lon, lat] of pts) {
			const p = project(lon, lat, R, sp, cp);
			if (!p.front) { pen = false; continue; }
			if (pen) ctx.lineTo(p.x, p.y);
			else { ctx.moveTo(p.x, p.y); pen = true; }
		}
		ctx.stroke();
	}

	// --- interaction -----------------------------------------------------------

	// screen point -> lon/lat by inverting the orthographic projection, or null if
	// the tap missed the sphere.
	function unproject(px, py) {
		const R = radius();
		const x = (px - cx) / R;
		const yr = -(py - cy) / R;
		const r2 = x * x + yr * yr;
		if (r2 > 1) return null; // outside the disc
		const zr = Math.sqrt(1 - r2);
		const sp = sinP(), cp = cosP();
		// invert pitch (rotate back about x-axis)
		const y = yr * cp + zr * sp;
		const z = -yr * sp + zr * cp;
		const lat = Math.asin(Math.max(-1, Math.min(1, y))) / DEG;
		const lon = yaw + Math.atan2(x, z) / DEG;
		return { lat, lon: wrapLon(lon) };
	}

	function geoAt(px, py) {
		if (flatT() >= 0.5) {
			// flat inversion is exact everywhere in the viewport - no disc to miss
			return encodeGeohash(latFromY(py), lonFromX(px), flatDepthFor(worldPx()));
		}
		const ll = unproject(px, py);
		if (!ll) return null;
		return encodeGeohash(ll.lat, ll.lon, depthFor(radius()));
	}

	let drag = null; // { x, y, moved }
	const pointers = new Map();
	let pinchBase = 0;

	function onDown(e) {
		canvas.setPointerCapture?.(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		lastInteract = performance.now();
		if (pointers.size === 2) {
			pinchBase = pinchDist();
		} else {
			drag = { x: e.clientX, y: e.clientY, moved: false };
		}
	}
	function onMove(e) {
		const r = canvas.getBoundingClientRect();
		if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2) {
			const d = pinchDist();
			if (pinchBase) setZoom(zoom * (d / pinchBase));
			pinchBase = d;
			lastInteract = performance.now();
			return;
		}
		if (drag) {
			const dx = e.clientX - drag.x;
			const dy = e.clientY - drag.y;
			if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
			if (flatT() > 0) {
				// flat pan: 1:1 ground tracking - the point under the pointer stays there
				const wpx = worldPx();
				yaw = wrapLon(yaw - (dx * 360) / wpx);
				pitch = Math.max(-84.9, Math.min(84.9, invMercY01(mercY01(pitch) - dy / wpx)));
			} else {
				// globe spin: slower as you zoom in, so navigation stays controllable
				const k = 0.25 / Math.sqrt(zoom);
				yaw = wrapLon(yaw - dx * k);
				pitch = Math.max(-89, Math.min(89, pitch + dy * k));
			}
			drag.x = e.clientX;
			drag.y = e.clientY;
			lastInteract = performance.now();
		} else if (e.pointerType === "mouse") {
			// hover highlight - mouse only. on touch it's unusable: a scroll/spin
			// drags the pointer across cells and flickers the selection, so we skip
			// it entirely and let taps pick directly.
			hoverGeo = geoAt(e.clientX - r.left, e.clientY - r.top);
		}
	}
	function onUp(e) {
		const wasDrag = drag && drag.moved;
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinchBase = 0;
		if (drag && !wasDrag && pointers.size === 0) {
			const r = canvas.getBoundingClientRect();
			const gh = geoAt(e.clientX - r.left, e.clientY - r.top);
			if (gh) onPick?.(gh);
		}
		drag = null;
	}
	function pinchDist() {
		const [a, b] = [...pointers.values()];
		return Math.hypot(a.x - b.x, a.y - b.y);
	}
	function onWheel(e) {
		e.preventDefault();
		setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
		const r = canvas.getBoundingClientRect();
		hoverGeo = geoAt(e.clientX - r.left, e.clientY - r.top);
		lastInteract = performance.now();
	}
	function setZoom(z) {
		zoom = Math.max(ZOOM_MIN, Math.min(maxZoom(), z));
	}

	// --- loop ------------------------------------------------------------------

	function frame() {
		if (!running) return;
		// gentle idle auto-spin when nobody's touched it for a moment (and not deep in)
		if (performance.now() - lastInteract > 2500 && !drag && pointers.size === 0 && zoom < 4) {
			yaw = wrapLon(yaw + 0.08);
		}
		// drop expired ripples so the array stays bounded
		if (pings.length) {
			const cutoff = performance.now() - PING_MS;
			if (pings.some((p) => p.born <= cutoff)) pings = pings.filter((p) => p.born > cutoff);
		}
		draw();
		raf = requestAnimationFrame(frame);
	}

	// --- public ----------------------------------------------------------------

	function open() {
		resize();
		running = true;
		lastInteract = performance.now();
		if (!raf) raf = requestAnimationFrame(frame);
	}
	function close() {
		running = false;
		if (raf) cancelAnimationFrame(raf);
		raf = null;
	}
	function setActivity(map, countMap) {
		activity = map instanceof Map ? map : new Map(Object.entries(map || {}));
		if (countMap !== undefined) counts = countMap instanceof Map ? countMap : new Map(Object.entries(countMap || {}));
	}

	// ripple a ping at a geohash's cell center - called when a message lands there
	// while the map is open. capped so a burst can't pile up unbounded.
	function ping(gh) {
		if (!gh || !/^[0-9a-z]{1,12}$/.test(gh)) return;
		const b = geohashBounds(gh);
		pings.push({ lon: wrapLon((b.lonLo + b.lonHi) / 2), lat: (b.latLo + b.latHi) / 2, born: performance.now() });
		if (pings.length > 60) pings = pings.slice(-60);
	}
	// center the view on `gh` and zoom so its cells frame at ~90px - used to drop
	// you onto your current channel when the map opens. broad channels (depth <=3)
	// frame on the globe; deeper ones land straight in the flat street view, which
	// is what lifted the old depth-3 ceiling.
	function focusGeohash(gh) {
		if (!gh || !/^[0-9a-z]{1,12}$/.test(gh)) return;
		const b = geohashBounds(gh);
		yaw = wrapLon((b.lonLo + b.lonHi) / 2);
		pitch = Math.max(-84.9, Math.min(84.9, (b.latLo + b.latHi) / 2));
		const minDim = Math.min(W, H) || 1;
		const { lon: lonBits } = bitsFor(gh.length);
		const wDeg = 360 / 2 ** lonBits;
		if (gh.length <= 3) {
			flatCosLat = null;
			setZoom(90 / (minDim * 0.42 * wDeg * DEG)); // ~90px cells on the globe
		} else {
			flatCosLat = Math.cos(pitch * DEG);
			const targetWorld = (90 * 360) / wDeg; // mercator world size where this depth reads at ~90px
			zoom = Math.max(FLAT_HI + 1, Math.min(maxZoom(), targetWorld / (minDim * 0.42 * flatCosLat * DEG * 360)));
		}
		lastInteract = performance.now();
	}
	// is a geohash's cell visible on-screen right now: front-facing (near hemisphere)
	// AND inside the canvas rect (so a zoomed-in view over asia doesn't count a
	// front-but-off-frame cell in africa). used to gate the live-chat ticker to
	// messages whose ping the viewer can actually see fire. mode-aware via the
	// blended projector, so the rule holds on the street map too.
	function isOnScreen(gh) {
		if (!gh || !/^[0-9a-z]{1,12}$/.test(gh)) return false;
		const b = geohashBounds(gh);
		const p = projectPoint(wrapLon((b.lonLo + b.lonHi) / 2), (b.latLo + b.latHi) / 2);
		return p.front && p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
	}
	function destroy() {
		close();
		ro?.disconnect();
		canvas.removeEventListener("pointerdown", onDown);
		canvas.removeEventListener("pointermove", onMove);
		canvas.removeEventListener("pointerup", onUp);
		canvas.removeEventListener("pointercancel", onUp);
		canvas.removeEventListener("wheel", onWheel);
		window.removeEventListener("resize", resize);
	}

	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("pointerup", onUp);
	canvas.addEventListener("pointercancel", onUp);
	canvas.addEventListener("wheel", onWheel, { passive: false });
	window.addEventListener("resize", resize);
	// the window resize event is unreliable on ios orientation flips (it can fire
	// with stale layout, or not at all), which left the canvas holding its old
	// landscape pixel size while the css box turned portrait - stretching the
	// globe. observe the canvas box directly so we re-measure exactly when it
	// actually changes size, whatever triggered it.
	const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
	ro?.observe(canvas);

	// read-only view snapshot, for debugging/tests (zoom axis, blend factor, and
	// which projection + grid depth are live right now).
	function view() {
		const t = flatT();
		return { zoom, t, mode: t >= 0.5 ? "flat" : "globe", depth: t >= 0.5 ? flatDepthFor(worldPx()) : depthFor(radius()) };
	}

	return { open, close, setActivity, ping, isOnScreen, focusGeohash, view, destroy, resize };
}

// --- helpers -----------------------------------------------------------------

function wrapLon(lon) {
	let x = lon;
	while (x > 180) x -= 360;
	while (x < -180) x += 360;
	return x;
}

// 3-vector cross product and normalize, for the terminator basis.
function cross(a, b) {
	return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function norm(a) {
	const m = Math.hypot(a.x, a.y, a.z) || 1;
	return { x: a.x / m, y: a.y / m, z: a.z / m };
}

// signed smallest angular delta from a0 to a1, in (-pi, pi].
function angDelta(a0, a1) {
	let d = a1 - a0;
	while (d > Math.PI) d -= TWO_PI;
	while (d <= -Math.PI) d += TWO_PI;
	return d;
}

// web-mercator y in [0,1] (0 = north edge, y-down) for a latitude, and back.
function mercY01(lat) {
	const p = Math.max(-MERC_LAT_MAX, Math.min(MERC_LAT_MAX, lat)) * DEG;
	return 0.5 - Math.log(Math.tan(Math.PI / 4 + p / 2)) / TWO_PI;
}
function invMercY01(y) {
	return (2 * Math.atan(Math.exp((0.5 - y) * TWO_PI)) - Math.PI / 2) / DEG;
}

// apply an alpha to a CSS color that may be #rgb/#rrggbb or rgb()/rgba(). falls
// back to wrapping in a color-mix-free rgba when possible.
function withAlpha(color, a) {
	const s = String(color).trim();
	let r, g, b;
	if (s[0] === "#") {
		let h = s.slice(1);
		if (h.length === 3) h = h.split("").map((c) => c + c).join("");
		const n = parseInt(h, 16);
		r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
	} else {
		const m = s.match(/(\d+(?:\.\d+)?)/g);
		if (m && m.length >= 3) { r = +m[0]; g = +m[1]; b = +m[2]; }
		else { r = g = b = 200; }
	}
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}
