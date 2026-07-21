// A hand-rolled wireframe globe for browsing geohash channels. Pure canvas 2D +
// an orthographic projection - no three.js, no webgl. Draws the sphere limb,
// vendored coastlines, a day/night terminator, and the geohash grid at a
// zoom-derived depth; glows cells with live activity, ripples a ping wherever a
// message just landed, labels cells with a live "here" count; drag to spin,
// wheel/pinch to zoom, tap a cell to join it.
//
// createMap({ canvas, onPick, colors }) -> { open, close, setActivity, ping, ... }
// colors: () => ({ accent, fg, muted, bg }) so the globe follows the theme.

import { COASTLINES } from "./coastlines.js";

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const NIGHT_ALPHA = 0.58; // how dark the night hemisphere shade sits over the land
const NIGHT_SHADE = "#03060c"; // near-black blue the night side dims toward
const TWILIGHT_BAND = 0.16; // half-width (in surface-normal dot units) of the soft dawn/dusk falloff
const NIGHT_GRID_DIM = 0.78; // how much a deep-night cell's outline/label fades (0 = none, 1 = gone)

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

	// view state: center lon/lat (yaw/pitch) + zoom (1 = globe fits the frame)
	let yaw = -20, pitch = 18, zoom = 1;
	const ZOOM_MIN = 1, ZOOM_MAX = 90;
	let activity = new Map(); // full-geohash -> intensity 0..1
	let counts = new Map(); // full-geohash -> distinct talkers "here" (last few min)
	let pings = []; // { lon, lat, born } expanding ripples where a message just landed
	const PING_MS = 1700; // a ping's ripple lives this long, then it's pruned
	let raf = null, running = false;
	let lastInteract = 0;
	let hoverGeo = null; // cell under the pointer (for the label/pick affordance)

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

	// --- drawing ---------------------------------------------------------------

	function draw() {
		const c = colors();
		const R = radius();
		const sp = sinP(), cp = cosP();
		ctx.clearRect(0, 0, W, H);

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

		// live message ripples ride above everything, so a ping reads even over a
		// bright, active cell.
		drawPings(R, sp, cp, c);

		ctx.restore();
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
	function drawPings(R, sp, cp, c) {
		if (!pings.length) return;
		const now = performance.now();
		for (const p of pings) {
			const age = (now - p.born) / PING_MS;
			if (age >= 1) continue;
			const prj = project(p.lon, p.lat, R, sp, cp);
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
			// slower rotation as you zoom in, so deep navigation stays controllable
			const k = 0.25 / Math.sqrt(zoom);
			yaw = wrapLon(yaw - dx * k);
			pitch = Math.max(-89, Math.min(89, pitch + dy * k));
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
		zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
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
	// rotate the globe so `gh`'s cell sits under the center, and zoom in enough to
	// frame it - used to drop you onto your current channel when the map opens.
	function focusGeohash(gh) {
		if (!gh || !/^[0-9a-z]{1,12}$/.test(gh)) return;
		const b = geohashBounds(gh);
		yaw = wrapLon((b.lonLo + b.lonHi) / 2);
		pitch = Math.max(-89, Math.min(89, (b.latLo + b.latHi) / 2));
		// zoom in so the region reads clearly, but cap the framed depth at 3: past
		// that the grid gets so fine that enumeration can't reach the center and the
		// view blanks. so we land on the neighborhood, and you zoom/tap the rest.
		const depth = Math.min(gh.length, 3);
		const { lon: lonBits } = bitsFor(depth);
		const wDeg = 360 / 2 ** lonBits;
		const minDim = Math.min(W, H) || 1;
		setZoom(90 / (minDim * 0.42 * wDeg * DEG)); // ~90px cells at this depth
		lastInteract = performance.now();
	}
	function destroy() {
		close();
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

	return { open, close, setActivity, ping, focusGeohash, destroy, resize };
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
