// "Flair": preset ambient effects for your whole chat line - a theme for your
// message row rather than for the app chrome. Distinct from "&"-code formatting
// (format.js), which owns text colors and styles: flair owns MOTION around the
// line, and the two compose freely.
//
// Everything is drawn procedurally by CSS keyframes (see .flair-* in style.css) -
// no images, no GIFs, no canvas, and no per-frame JavaScript at all. Each effect
// animates only `opacity` and `transform` on one or two pseudo-elements, which the
// browser hands to the compositor, so a screenful of flaired lines costs
// essentially nothing on the main thread. Particle fields are one 2px dot cloned
// by `box-shadow` into a dozen sparks, so a whole ember shower is a single
// composited layer.
//
// This module is the registry only, kept DOM-free so it can be reasoned about (and
// tested) in isolation. A name reaching the DOM becomes a CSS class, so the
// whitelist here is load-bearing: unknown names resolve to "" rather than being
// interpolated into markup.

export const FLAIRS = ["fire", "lightning", "stars", "rain", "plume", "neon"];

const KNOWN = new Set(FLAIRS);

// How many of THIS flair may animate on screen at once. 0 = no limit.
//
// The flairs are nowhere near equally expensive, so one global cap is the wrong
// knob: it's either too tight for the cheap ones or too loose for the dear ones.
// Four of these are a couple of pseudo-elements animating opacity and transform,
// which the compositor eats by the screenful. Plume is a different animal - two
// animated pseudo-elements plus half a dozen BLURRED, screen-BLENDED blobs and
// their motes, each on its own animations. Blur and blend are the expensive words:
// they can't be composited as cheaply as a transform, and they stack.
//
// So the number lives next to the effect that earns it. Anything new starts at 0
// and only gets a limit if it's measured to need one.
const FLAIR_LIMITS = {
	fire: 0,
	lightning: 0,
	stars: 0,
	rain: 0,
	plume: 3,
	// two pseudo-elements animating opacity and nothing else - no blur, no blend, no
	// particles. Cheaper than any of the others, so it starts uncapped like they did.
	neon: 0,
};

// how many of `raw` may animate at once; 0 for unlimited (and for unknown names,
// which render nothing anyway).
export function flairLimit(raw) {
	const n = flairName(raw);
	return n && FLAIR_LIMITS[n] > 0 ? FLAIR_LIMITS[n] : 0;
}

// names this flair used to answer to. Renaming a flair is not free: the choice is
// persisted in localStorage indefinitely, and it rides along on every message as
// ["glub","flair",...], so a peer on an older build is still sending the old name
// right now. Without this table both would fall through the whitelist below and
// resolve to "" - a saved preference would silently vanish and their rows would
// render bare. One line each is cheaper than either failure.
const ALIASES = { plasma: "plume" };

// normalize an untrusted flair name (yours or a peer's) to a known one, or "".
export function flairName(raw) {
	const s = String(raw || "").trim().toLowerCase();
	const n = ALIASES[s] || s;
	return KNOWN.has(n) ? n : "";
}

// the class pair a flaired element needs: the shared base plus the effect itself.
// "" for an unknown name, so callers can concatenate unconditionally.
export function flairClass(raw) {
	const n = flairName(raw);
	return n ? `flair flair-${n}` : "";
}

// --- per-line randomization ---------------------------------------------------
// An effect built from fixed keyframes looks mechanical: every line twinkles the
// same shape, at the same moment, forever. So the *inputs* are randomized per
// line instead - the star field, the twinkle periods, the phase offsets - and
// handed to CSS as custom properties. The animations stay pure CSS (compositor,
// no per-frame JS); the randomness costs a few Math.random() calls the one time a
// line is built. Every message gets its own night sky.

const rnd = (min, max) => min + Math.random() * (max - min);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// --- how a neon tube is bent ----------------------------------------------------
// A sign is one length of tube a glassblower bent to a shape, and the tell is that
// it DOUBLES BACK: it runs out along the top, turns, comes back underneath, tucks
// inside itself. A single rectangle around the row can never do that - it is a
// border with a glow on it, which is the one thing this flair is trying not to be.
//
// So a shape is two PIECES, and the wrap is what happens between them. Each piece is
// a box with some of its sides drawn, so both together are two elements with four
// border widths each - no markup, no extra layers, nothing per-frame.
//
// The horizontal run is what carries the effect, and it is easy to underestimate. A
// chat row is twenty-odd pixels tall and several hundred wide, so dropping a SIDE
// changes about one pixel at the far edge and every shape still reads as the same
// long box. Stopping one piece at 58% and starting the other at 40%, so they overlap
// through the middle at different heights, is unmistakable from across the screen.
//
// x0/x1 are the run in percent; `top`/`bottom` inset the piece vertically in px, and
// a piece set in on BOTH is one the tube has coiled inside itself. Radii use the CSS
// shorthand order: top-left, top-right, bottom-right, bottom-left.
const NEON_SHAPES = [
	{
		// the closed sign, with the tube tucked back inside along the bottom
		name: "coil",
		p1: { t: 1, r: 1, b: 1, l: 1, x0: 0, x1: 100, top: 0, bottom: 0, radius: "5px" },
		p2: { t: 0, r: 0, b: 1, l: 1, x0: 10, x1: 74, top: 5, bottom: 4, radius: "0 0 0 7px" },
	},
	{
		// out along the top, down at the end, back underneath - the classic bend
		name: "switchback",
		p1: { t: 1, r: 1, b: 0, l: 0, x0: 0, x1: 100, top: 0, bottom: 0, radius: "0 9px 0 0" },
		p2: { t: 0, r: 0, b: 1, l: 1, x0: 0, x1: 100, top: 0, bottom: 0, radius: "0 0 0 9px" },
	},
	{
		// two rails that overlap through the middle at different heights, so the tube
		// reads as crossing back over itself
		name: "crossover",
		p1: { t: 1, r: 1, b: 0, l: 0, x0: 0, x1: 58, top: 0, bottom: 0, radius: "0 10px 0 0" },
		p2: { t: 0, r: 0, b: 1, l: 1, x0: 40, x1: 100, top: 0, bottom: 0, radius: "0 0 0 10px" },
	},
	{
		// a bracket at each end, facing each other
		name: "clasp",
		p1: { t: 1, r: 0, b: 1, l: 1, x0: 0, x1: 30, top: 0, bottom: 0, radius: "9px 0 0 9px" },
		p2: { t: 1, r: 1, b: 1, l: 0, x0: 68, x1: 100, top: 0, bottom: 0, radius: "0 9px 9px 0" },
	},
	{
		// a staple over the head, a trough under the tail
		name: "stagger",
		p1: { t: 1, r: 1, b: 0, l: 1, x0: 0, x1: 46, top: 0, bottom: 0, radius: "8px 8px 0 0" },
		p2: { t: 0, r: 1, b: 1, l: 1, x0: 34, x1: 100, top: 0, bottom: 0, radius: "0 0 8px 8px" },
	},
	{
		// a frame with a second, shorter run nested inside it
		name: "nested",
		p1: { t: 1, r: 1, b: 1, l: 1, x0: 0, x1: 100, top: 0, bottom: 0, radius: "5px" },
		p2: { t: 1, r: 1, b: 0, l: 0, x0: 16, x1: 86, top: 4, bottom: 5, radius: "0 6px 0 0" },
	},
	{
		// bare rails over and under, the top one hooking back down at its left
		name: "return",
		p1: { t: 1, r: 0, b: 0, l: 1, x0: 0, x1: 100, top: 0, bottom: 0, radius: "8px 0 0 0" },
		p2: { t: 0, r: 1, b: 1, l: 0, x0: 12, x1: 100, top: 0, bottom: 0, radius: "0 0 8px 0" },
	},
	{
		// a long trough with a short hood over its start, tucked in
		name: "hood",
		p1: { t: 0, r: 1, b: 1, l: 1, x0: 0, x1: 100, top: 0, bottom: 0, radius: "0 0 7px 7px" },
		p2: { t: 1, r: 0, b: 0, l: 1, x0: 6, x1: 52, top: 3, bottom: 6, radius: "7px 0 0 0" },
	},
];

// the css custom properties one piece of tube needs
function neonPiece(prefix, s) {
	return {
		[`${prefix}-t`]: s.t ? "1px" : "0",
		[`${prefix}-r`]: s.r ? "1px" : "0",
		[`${prefix}-b`]: s.b ? "1px" : "0",
		[`${prefix}-l`]: s.l ? "1px" : "0",
		[`${prefix}-inset`]: `${s.top}px ${100 - s.x1}% ${s.bottom}px ${s.x0}%`,
		[`${prefix}-radius`]: s.radius,
	};
}

// flairs that want an extra one-shot layer in the markup, fired by a shared ticker
// (see app.js): the stars flair's shooting star, the lightning flair's strike.
// (fire and rain instead use it as a persistent container of individual particles:
// one element per spark/drop is the only way each gets its own spawn time and path,
// which a box-shadow field - one element, one animation - cannot give.)
const FX_FLAIRS = new Set(["stars", "lightning", "fire", "rain", "plume", "neon"]);

export function flairHasFx(raw) {
	return FX_FLAIRS.has(flairName(raw));
}

// what a flair's fx layer starts life containing. Empty for the one-shot effects
// (stars/lightning fill it at fire time); fire pre-populates it with its embers,
// emitted from messageHtml so they survive every in-place rerender.
export function flairFxInner(raw) {
	const n = flairName(raw);
	if (n === "fire") return fireEmberMarkup();
	if (n === "rain") return rainDropMarkup();
	if (n === "plume") return plumePuffMarkup();
	// neon's fx layer holds the one part of it that isn't tube: the segment that
	// gives out. Both pseudo-elements are spoken for by the two lengths of glass.
	if (n === "neon") return `<span class="neonDead"></span>`;
	return "";
}

// cool white-blues, so a field reads as starlight rather than confetti
const STAR_TINTS = ["#ffffff", "#ffffff", "#cfe6ff", "#a8ccff", "#dbe9ff", "#bcd8ff", "#e9f2ff"];

// one 2px dot is cloned into a whole field by box-shadow, so a random field is
// just a random offset list - still a single composited layer no matter how many
// particles it holds. X advances by a jittered step rather than being uniformly
// random, which keeps particles from clumping the way pure noise does.
function particleField(count, step, jitterY, tints) {
	const out = [];
	let x = 0;
	for (let i = 0; i < count; i++) {
		x += rnd(step * 0.55, step * 1.45);
		out.push(`${Math.round(x)}px ${Math.round(rnd(-jitterY, jitterY))}px ${pick(tints)}`);
	}
	return out.join(", ");
}

// --- procedural lightning ------------------------------------------------------
// A bolt is generated as SVG markup on the fly - a jagged polyline down the row
// with a soft wide stroke under a bright thin core, plus a fork about half the
// time. No assets and no canvas: it's a string, built only at the moment a strike
// fires and dropped from the DOM again when the animation ends. Every bolt is a
// different shape.
export function lightningStrikeMarkup(w, h) {
	const width = Math.max(60, Math.round(w));
	const height = Math.max(8, Math.round(h));
	const jitter = width * 0.055;
	const segs = 3 + ((Math.random() * 3) | 0);
	const pts = [];
	let x = width * (0.12 + Math.random() * 0.76);
	for (let i = 0; i <= segs; i++) {
		const y = (height / segs) * i;
		pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
		x = Math.max(2, Math.min(width - 2, x + (Math.random() * 2 - 1) * jitter));
	}
	const main = pts.join(" ");
	// a fork peels off a middle vertex and dies partway down
	let fork = "";
	if (Math.random() < 0.55 && pts.length > 2) {
		const i = 1 + ((Math.random() * (pts.length - 2)) | 0);
		const [fx, fy] = pts[i].split(",").map(Number);
		const dir = Math.random() < 0.5 ? -1 : 1;
		const f = [
			`${fx.toFixed(1)},${fy.toFixed(1)}`,
			`${(fx + dir * jitter * 1.6).toFixed(1)},${Math.min(height, fy + height * 0.22).toFixed(1)}`,
			`${(fx + dir * jitter * 2.4).toFixed(1)},${Math.min(height, fy + height * 0.44).toFixed(1)}`,
		].join(" ");
		fork = `<polyline class="boltGlow" points="${f}"/><polyline class="boltCore" points="${f}"/>`;
	}
	// the flash sits under the bolt so a strike lights the whole row, not just the
	// path - that's what makes it read as lightning rather than a drawn squiggle.
	// Wrapped in one node so a caller can APPEND and remove it: the rain flair keeps
	// its drops in the same layer, and replacing the layer's contents would wipe them.
	return (
		`<span class="strike">` +
		`<span class="boltFlash"></span>` +
		`<svg class="boltSvg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">` +
		`<polyline class="boltGlow" points="${main}"/><polyline class="boltCore" points="${main}"/>${fork}` +
		`</svg>` +
		`</span>`
	);
}

// embers glow warm; ash is what's left of them, so field B mixes dull greys in
const EMBER_TINTS = ["#ffb057", "#ff7a18", "#ffd08a", "#ff9d3d", "#ffc46b", "#ff6a00"];
const ASH_TINTS = ["#8a7f77", "#6d635c", "#b9a89a", "#c9762f", "#7d726a", "#ffa14d"];

// a drifting particle's lateral path, as offsets the keyframes ease through. Signs
// alternate around a constant `lean` (the line's prevailing draft) so the particle
// serpentines rather than travelling straight. Amplitudes are deliberately gentle:
// big alternating offsets read as a jolt at every waypoint, not a float.
function wobble(prefix, amp, lean) {
	const d = Math.random() < 0.5 ? -1 : 1;
	return {
		[`${prefix}1`]: `${(d * amp * 0.4 + lean * 0.3).toFixed(1)}px`,
		[`${prefix}2`]: `${(-d * amp * 0.5 + lean * 0.65).toFixed(1)}px`,
		[`${prefix}3`]: `${(d * amp * 0.35 + lean).toFixed(1)}px`,
	};
}

// --- individual embers ----------------------------------------------------------
// The bright embers can't be a box-shadow field: one element means ONE animation,
// so every clone is locked to the same spawn moment and the same path - the tell
// that made the old shower look like a marching row. Each ember is its own span
// instead, and gets TWO animations that compose into the final transform:
//
//   `translate` (rise + lifetime) - linear, so vertical speed stays steady
//   `transform` (sway)            - ease-in-out + alternate, a smooth oscillation
//
// Because the two run at unrelated periods, the combined path is a non-repeating
// serpentine with no corners in it, and because every ember has its own period and
// a random negative delay, they drift in and out of phase forever: sometimes a
// cluster, sometimes a lull with nothing rising at all. The `emberShort` variant
// dies partway up, so a given spark may or may not make it.
const EMBER_MIN = 5;
const EMBER_MAX = 7;

export function fireEmberMarkup() {
	const count = EMBER_MIN + ((Math.random() * (EMBER_MAX - EMBER_MIN + 1)) | 0);
	let html = "";
	for (let i = 0; i < count; i++) {
		const short = Math.random() < 0.4; // ~2 in 5 burn out before the top
		const size = Math.random() < 0.25 ? 3 : 2;
		const style = [
			`--e-x:${Math.round(rnd(4, 92))}%`,
			`--e-size:${size}px`,
			`--e-tint:${pick(EMBER_TINTS)}`,
			`--e-peak:${rnd(0.62, 1).toFixed(2)}`,
			`--e-lift:${rnd(1.5, 2.6).toFixed(2)}em`,
			`--e-amp:${rnd(3, 11).toFixed(1)}px`,
			// unrelated periods for rise vs sway, each phase-shifted on its own
			`--e-rise:${rnd(2.8, 6.4).toFixed(2)}s`,
			`--e-rise-delay:-${rnd(0, 7).toFixed(2)}s`,
			`--e-sway:${rnd(1.3, 2.9).toFixed(2)}s`,
			`--e-sway-delay:-${rnd(0, 3).toFixed(2)}s`,
		].join(";");
		html += `<span class="ember${short ? " emberShort" : ""}" style="${style}"></span>`;
	}
	return html;
}

// --- rain ----------------------------------------------------------------------
// Rain is the first flair whose motion goes DOWN, and the detail that sells it is
// the impact: rather than decorating the bottom edge with unrelated rings, each
// drop IS its own ripple - at the end of its fall it flattens and spreads into a
// wide, thin ellipse (transform-origin at its foot), so every splash is
// perfectly correlated with a real drop and costs no extra element.
//
// Two animations per drop compose into the transform, as with embers, but here they
// share one period so the fall and the splash stay in phase:
//   `translate` - the fall (linear, plus this line's wind lean) + opacity
//   `transform` - the splash (a scale that flattens the drop on landing)
const RAIN_TINTS = ["#cfe4f5", "#9fc0d8", "#eaf4ff", "#b9d3e6", "#8fb0c8", "#dceaf6"];
const DROP_MIN = 7;
const DROP_MAX = 10;

// The one value here that is deliberately NOT randomized. Everything else about a
// drop varies per line, but wind does not: a screenful of rain messages each
// slanting their own way reads as chaos, not weather, because a real downpour has a
// single prevailing direction across the whole scene. So the drift is a constant and
// only its magnitude wobbles slightly per drop - enough that the streaks aren't a
// printed pattern, never enough to flip one against the rest.
const RAIN_WIND_PX = 7; // horizontal drift over a full fall, same for every line

export function rainDropMarkup() {
	const count = DROP_MIN + ((Math.random() * (DROP_MAX - DROP_MIN + 1)) | 0);
	let html = "";
	for (let i = 0; i < count; i++) {
		// same wind on every line and every drop, give or take a little (see RAIN_WIND_PX)
		const drift = RAIN_WIND_PX * rnd(0.85, 1.15);
		// the streak is tilted to match the direction it's actually travelling -
		// a vertical dash drifting sideways reads as sliding, not falling
		const tilt = Math.max(-17, Math.min(17, drift * 1.6));
		const style = [
			`--d-x:${Math.round(rnd(2, 96))}%`,
			`--d-len:${rnd(5, 10).toFixed(1)}px`,
			`--d-tint:${pick(RAIN_TINTS)}`,
			`--d-op:${rnd(0.45, 0.95).toFixed(2)}`,
			`--d-lean:${drift.toFixed(1)}px`,
			`--d-tilt:${tilt.toFixed(1)}deg`,
			`--d-ring:${rnd(7, 13).toFixed(1)}px`,
			// gravity is quick: short periods and high turnover. The random negative
			// delay scatters the spawn moments into a real shower rather than a row.
			`--d-fall:${rnd(0.34, 0.72).toFixed(2)}s`,
			`--d-delay:-${rnd(0, 1.2).toFixed(2)}s`,
		].join(";");
		html += `<span class="drop" style="${style}"></span>`;
	}
	return html;
}

// --- plume ---------------------------------------------------------------------
// A violet plume lit from the LEFT edge of the row, burning out along the top and
// bottom and dying to black toward the right. Where the other flairs are made of
// PARTICLES you can count, this one is made of volume: a few very large, very soft
// blobs drifting and swelling past each other behind the text.
//
// Two things carry the look, and neither is the blobs themselves.
//
// First, `screen` blending: where two puffs overlap their light ADDS, which is what
// a camera does when it can't hold the highlights - lit evenly, but wherever the
// volume is densest the value clips and blows out toward white. Painting those hot
// spots directly would mean deciding up front where they go; letting overlap decide
// means they move as the plume moves and land somewhere new on every line, free.
//
// Second, everything is masked by one left-to-right falloff (see the stylesheet), so
// the plume is brightest where a line starts and gone by the time it ends. Puffs are
// biased to the left THIRD to match, rather than relying on the mask alone to hide
// blobs that shouldn't have been drawn further out in the first place. The plume is
// an accent on the start of a line, not a background behind the whole of it.
//
// Three animations compose per puff, all with unrelated periods and their own phase:
//   `translate` - the drift (ease-in-out + alternate: a lazy wander, no corners)
//   `transform` - the swell (scale, ditto - plume breathes, it doesn't pulse)
//   `opacity`   - the density passing through the light
// Nothing shares a period with anything else, so the field churns rather than
// looping, and no two lines are ever at the same moment of it.
const PLASMA_TINTS = ["#a855f7", "#c084fc", "#8b5cf6", "#9333ea", "#b06cf0", "#7e3ff2"];
// the blown-out centres - near-white with only a hint of the violet left in them
const PLASMA_CORES = ["#f3e8ff", "#efe0ff", "#ffffff", "#e9d5ff", "#f7efff"];
const PUFF_MIN = 4;
const PUFF_MAX = 6;

// Motes: a few specks that spawn out in the dark, where the plume's glow has
// already tapered off, and drift LEFT into it - so the plume reads as drawing them
// in rather than shedding them. They fade up out of nothing at the far end and are
// swallowed (fading again) as they reach the bright edge, which is what sells the
// direction: something that arrives from the dark and doesn't come out the other
// side has been consumed.
//
// Sparse on purpose. A dense stream would read as rain blowing sideways; two or
// three at a time, on long unrelated periods, reads as the odd particle being
// pulled in. They travel with a slight vertical drift so they arc rather than
// tracking a ruled line.
const MOTE_TINTS = ["#e9d5ff", "#c084fc", "#f3e8ff", "#d8b4fe", "#a855f7"];
const MOTE_MIN = 2;
const MOTE_MAX = 4;

function plumeMoteMarkup() {
	const count = MOTE_MIN + ((Math.random() * (MOTE_MAX - MOTE_MIN + 1)) | 0);
	let html = "";
	for (let i = 0; i < count; i++) {
		const style = [
			// starts beyond where the glow has faded out, ends inside the bright edge
			`--m-from:${Math.round(rnd(62, 108))}%`,
			`--m-to:${Math.round(rnd(4, 20))}%`,
			`--m-y:${Math.round(rnd(12, 88))}%`,
			`--m-rise:${rnd(-7, 7).toFixed(1)}px`,
			`--m-size:${Math.random() < 0.3 ? 2 : 1.4}px`,
			`--m-tint:${pick(MOTE_TINTS)}`,
			`--m-op:${rnd(0.4, 0.85).toFixed(2)}`,
			// slow, and long gaps between: the delay is a big negative so most motes
			// spend most of the cycle already gone
			`--m-dur:${rnd(4.5, 9.5).toFixed(2)}s`,
			`--m-delay:-${rnd(0, 9).toFixed(2)}s`,
		].join(";");
		html += `<span class="mote" style="${style}"></span>`;
	}
	return html;
}

export function plumePuffMarkup() {
	const count = PUFF_MIN + ((Math.random() * (PUFF_MAX - PUFF_MIN + 1)) | 0);
	let html = "";
	for (let i = 0; i < count; i++) {
		// larger than the row is tall (a blob small enough to read as a shape stops
		// reading as volume) but no larger than it needs to be. Size and position are
		// now the ONLY things keeping the blobs on the lit side - the layer they live in
		// dropped its mask so the motes could be seen out in the dark - so an oversized
		// or right-leaning blob puts colour where the plume should already be gone.
		const size = Math.round(rnd(54, 108));
		const style = [
			`--p-x:${Math.round(rnd(-18, 19))}%`,
			`--p-y:${Math.round(rnd(15, 85))}%`,
			`--p-size:${size}px`,
			`--p-tint:${pick(PLASMA_TINTS)}`,
			`--p-core:${pick(PLASMA_CORES)}`,
			`--p-blur:${Math.round(rnd(10, 22))}px`,
			`--p-op:${rnd(0.28, 0.55).toFixed(2)}`,
			`--p-dx:${rnd(-16, 16).toFixed(1)}px`,
			`--p-dy:${rnd(-9, 9).toFixed(1)}px`,
			`--p-swell:${rnd(1.12, 1.42).toFixed(2)}`,
			`--p-drift-dur:${rnd(7.5, 15).toFixed(2)}s`,
			`--p-drift-delay:-${rnd(0, 14).toFixed(2)}s`,
			`--p-swell-dur:${rnd(4.6, 9.4).toFixed(2)}s`,
			`--p-swell-delay:-${rnd(0, 9).toFixed(2)}s`,
			`--p-breathe-dur:${rnd(5.2, 11).toFixed(2)}s`,
			`--p-breathe-delay:-${rnd(0, 10).toFixed(2)}s`,
		].join(";");
		html += `<span class="puff" style="${style}"></span>`;
	}
	// the motes ride in the same layer, so they're masked and blended with the plume
	return html + plumeMoteMarkup();
}

// the plume surging: one dense billow that swells out of nowhere and thins away.
// Appended and removed like the rain squall, so it never disturbs the puffs it
// passes through - it just briefly gives them something much brighter to overlap.
// Kept to the lit half of the row, since that's where the plume lives.
export function plumeSurgeMarkup() {
	return (
		`<span class="surge" style="` +
		`--ps-x:${Math.round(rnd(1, 20))}%;` +
		`--ps-tint:${pick(PLASMA_TINTS)};` +
		`--ps-core:${pick(PLASMA_CORES)}` +
		`"></span>`
	);
}

// a squall: one translucent slanted sheet driven across the row. Appended for the
// ~600ms it lasts and removed again, so it never disturbs the drops it passes.
export function rainGustMarkup() {
	const tilt = rnd(8, 16) * (Math.random() < 0.5 ? -1 : 1);
	return `<span class="gust" style="--g-tilt:${tilt.toFixed(1)}deg"></span>`;
}

// the CSS custom properties a flaired line wants, as { "--name": value }. Unknown
// or var-less flairs get {} - the stylesheet carries fallbacks for every var, so a
// line (or a /flair preview chip) with no vars set still renders correctly.
export function flairVars(raw) {
	const n = flairName(raw);
	// a fire never repeats itself: the glow's huff, both ember fields' speed, phase,
	// spacing, colour and corkscrew all differ per line, so a screenful of fire
	// lines breathes out of step instead of pulsing as one.
	if (n === "fire") {
		const lean = rnd(-6, 9); // this line's prevailing draft
		return {
			"--fire-glow-dur": `${rnd(2.6, 5.2).toFixed(2)}s`,
			"--fire-glow-delay": `-${rnd(0, 5).toFixed(2)}s`,
			"--fire-glow-peak": rnd(0.82, 1).toFixed(2),
			"--fire-glow-low": rnd(0.34, 0.55).toFixed(2),
			// the bright embers are individual spans (see fireEmberMarkup); this field
			// is only the dim ash haze behind them, where uniform timing doesn't read
			// - it's slow, faint, and snuffs out partway up (see flairAshRise).
			"--ash-field": particleField(5, 68, 5, ASH_TINTS),
			"--ash-left": `${Math.round(rnd(8, 40))}px`,
			"--ash-dur": `${rnd(4.2, 7.5).toFixed(2)}s`,
			"--ash-delay": `-${rnd(0, 7).toFixed(2)}s`,
			...wobble("--ash-x", rnd(6, 13), lean),
			"--fire-text-dur": `${rnd(3.4, 6.2).toFixed(2)}s`,
			"--fire-text-delay": `-${rnd(0, 5).toFixed(2)}s`,
		};
	}
	// a storm is never in sync with itself: every line gets its own flash cadence,
	// phase, brightness and origin, so the room flickers unevenly like real weather.
	if (n === "lightning") {
		return {
			"--lit-haze-dur": `${rnd(4.5, 9).toFixed(2)}s`,
			"--lit-haze-delay": `-${rnd(0, 6).toFixed(2)}s`,
			"--lit-flash-dur": `${rnd(6.5, 14).toFixed(2)}s`,
			"--lit-flash-delay": `-${rnd(0, 12).toFixed(2)}s`,
			"--lit-flash-peak": rnd(0.18, 0.42).toFixed(2), // the faint sheet-lightning glow
			"--lit-flash-x": `${Math.round(rnd(12, 88))}%`, // where the glow is centred
			"--lit-text-dur": `${rnd(5.5, 9.5).toFixed(2)}s`, // the &g wildcard's flicker
			"--lit-text-delay": `-${rnd(0, 8).toFixed(2)}s`,
		};
	}
	// rain's drops carry their own timing (see rainDropMarkup); these are the row's
	// ambient layers - the overcast wash and the wet gleam along the bottom edge.
	if (n === "rain") {
		return {
			"--rain-haze-dur": `${rnd(5, 9.5).toFixed(2)}s`,
			"--rain-haze-delay": `-${rnd(0, 8).toFixed(2)}s`,
			"--rain-haze-peak": rnd(0.55, 0.9).toFixed(2),
			"--rain-text-dur": `${rnd(2.4, 4.6).toFixed(2)}s`,
			"--rain-text-delay": `-${rnd(0, 4).toFixed(2)}s`,
		};
	}
	// the puffs carry their own timing (see plumePuffMarkup); these are the row's
	// ambient layers - the violet wash, the edge burn along the top and bottom, and
	// the lamp behind the plume, which drifts so the source isn't nailed to one spot.
	if (n === "plume") {
		return {
			"--plume-wash-dur": `${rnd(6.5, 12).toFixed(2)}s`,
			"--plume-wash-delay": `-${rnd(0, 11).toFixed(2)}s`,
			"--plume-wash-peak": rnd(0.5, 0.8).toFixed(2),
			"--plume-lamp-x": `${Math.round(rnd(4, 22))}%`,
			"--plume-lamp-dur": `${rnd(9, 17).toFixed(2)}s`,
			"--plume-lamp-delay": `-${rnd(0, 16).toFixed(2)}s`,
			// how dim and how bright THIS line's plume burns between. A wide, per-line
			// swing is most of what stops a screenful of them pulsing as one organism.
			"--plume-lamp-low": rnd(0.32, 0.5).toFixed(2),
			"--plume-lamp-peak": rnd(0.74, 0.98).toFixed(2),
			// and how far it reaches, on its own period - so length and brightness are
			// never in step, which is what keeps it from looking like a single throb.
			// `far` is the once-a-cycle long throw (see flairPlumeReach): several
			// times the resting length, enough to run most of the way across a line.
			// The period is long so it stays an event rather than a rhythm.
			"--plume-reach-min": rnd(0.6, 0.82).toFixed(2),
			"--plume-reach-max": rnd(1.02, 1.24).toFixed(2),
			"--plume-reach-far": rnd(1.9, 3.3).toFixed(2),
			"--plume-reach-dur": `${rnd(16, 30).toFixed(2)}s`,
			"--plume-reach-delay": `-${rnd(0, 30).toFixed(2)}s`,
			"--plume-text-dur": `${rnd(4.5, 8.5).toFixed(2)}s`,
			"--plume-text-delay": `-${rnd(0, 8).toFixed(2)}s`,
		};
	}
	// neon is a FRAME, not a field: everything it does happens on the row's outline.
	// Two things are randomized, and they're the two that would give the trick away
	// if they weren't - the buzz's period, and everything about the failing segment.
	// A tube that always dies in the same place at the same interval is a loop; one
	// that dies somewhere new, on a period nothing else shares, is a broken sign.
	if (n === "neon") {
		// which colour this tube burns, and which one haloes it. Splitting it per line
		// is what makes a screenful read as a street of signs rather than one repeated
		// sign. The CORE is white for every line - that is what reads as lit gas - and
		// the colour lives in the thin bloom just outside it.
		const pinkFirst = Math.random() < 0.62; // pink leads more often - it's the warmer read
		const HOT_PINK = "#ff2d95";
		const CYAN = "#22e6ff";
		const shape = pick(NEON_SHAPES);
		// the failure has to land on a rail one of the pieces actually HAS, and within
		// the stretch that piece runs along - otherwise the sign goes out somewhere
		// there was never any tube to go out. Whichever piece it picks, the segment is
		// placed against that piece's own geometry.
		const rails = [];
		for (const [piece, part] of [[shape.p1, "p1"], [shape.p2, "p2"]]) {
			if (piece.t) rails.push({ piece, part, edge: "top" });
			if (piece.b) rails.push({ piece, part, edge: "bottom" });
		}
		const hit = pick(rails);
		const run = hit.piece.x1 - hit.piece.x0;
		const deadW = Math.max(10, Math.round(rnd(run * 0.22, run * 0.42)));
		const deadX = Math.round(hit.piece.x0 + rnd(2, Math.max(3, run - deadW - 2)));
		// the rail's own vertical offset, so the gap sits ON the tube rather than where
		// the tube would be if the piece weren't inset
		const railY = hit.edge === "top" ? hit.piece.top : hit.piece.bottom;
		return {
			"--neon-lit": pinkFirst ? HOT_PINK : CYAN,
			"--neon-halo": pinkFirst ? CYAN : HOT_PINK,
			...neonPiece("--neon-p1", shape.p1),
			...neonPiece("--neon-p2", shape.p2),
			// the hum: fast, shallow, and on its own period per line so no two tubes
			// buzz together. Anything slower than about a second stops reading as
			// electrical and starts reading as breathing.
			"--neon-hum-dur": `${rnd(0.62, 1.35).toFixed(2)}s`,
			"--neon-hum-delay": `-${rnd(0, 1.2).toFixed(2)}s`,
			// the dead-tube stutter. Long period, because it has to stay an EVENT: a
			// tube that gutters every few seconds is a strobe, and the whole point is
			// that you catch it out of the corner of your eye.
			"--neon-dead-dur": `${rnd(11, 23).toFixed(2)}s`,
			"--neon-dead-delay": `-${rnd(0, 22).toFixed(2)}s`,
			"--neon-dead-top": hit.edge === "top" ? `${railY - 5}px` : "auto",
			"--neon-dead-bottom": hit.edge === "top" ? "auto" : `${railY - 5}px`,
			"--neon-dead-x": `${deadX}%`,
			"--neon-dead-w": `${deadW}%`,
			"--neon-text-dur": `${rnd(4, 7).toFixed(2)}s`,
			"--neon-text-delay": `-${rnd(0, 6).toFixed(2)}s`,
		};
	}
	if (n !== "stars") return {};
	return {
		// two independent fields: a denser one up top, a sparser one lower down
		"--star-a-field": particleField(7, 46, 11, STAR_TINTS),
		"--star-b-field": particleField(5, 60, 12, STAR_TINTS),
		"--star-a-left": `${Math.round(rnd(4, 28))}px`,
		"--star-a-top": `${Math.round(rnd(16, 40))}%`,
		"--star-b-left": `${Math.round(rnd(12, 46))}px`,
		"--star-b-top": `${Math.round(rnd(54, 80))}%`,
		// where each field re-appears after twinkling out (the keyframes move it
		// while it's invisible, so stars come back somewhere new)
		"--star-a-dx": `${Math.round(rnd(-16, 20))}px`,
		"--star-a-dy": `${Math.round(rnd(-7, 7))}px`,
		"--star-b-dx": `${Math.round(rnd(-20, 16))}px`,
		"--star-b-dy": `${Math.round(rnd(-7, 7))}px`,
		// periods differ per line AND per field, so nothing beats in unison; the
		// negative delay starts each one mid-cycle so lines never march together.
		"--star-a-dur": `${rnd(2.2, 4.8).toFixed(2)}s`,
		"--star-b-dur": `${rnd(2.8, 5.6).toFixed(2)}s`,
		"--star-a-delay": `-${rnd(0, 5).toFixed(2)}s`,
		"--star-b-delay": `-${rnd(0, 5).toFixed(2)}s`,
	};
}
