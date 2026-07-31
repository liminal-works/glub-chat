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

export const FLAIRS = ["fire", "lightning", "stars", "rain", "plasma"];

const KNOWN = new Set(FLAIRS);

// normalize an untrusted flair name (yours or a peer's) to a known one, or "".
export function flairName(raw) {
	const s = String(raw || "").trim().toLowerCase();
	return KNOWN.has(s) ? s : "";
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

// flairs that want an extra one-shot layer in the markup, fired by a shared ticker
// (see app.js): the stars flair's shooting star, the lightning flair's strike.
// (fire and rain instead use it as a persistent container of individual particles:
// one element per spark/drop is the only way each gets its own spawn time and path,
// which a box-shadow field - one element, one animation - cannot give.)
const FX_FLAIRS = new Set(["stars", "lightning", "fire", "rain", "plasma"]);

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
	if (n === "plasma") return plasmaPuffMarkup();
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

// --- plasma ---------------------------------------------------------------------
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
// biased to the left half to match, rather than relying on the mask alone to hide
// blobs that shouldn't have been drawn on the right in the first place.
//
// Three animations compose per puff, all with unrelated periods and their own phase:
//   `translate` - the drift (ease-in-out + alternate: a lazy wander, no corners)
//   `transform` - the swell (scale, ditto - plasma breathes, it doesn't pulse)
//   `opacity`   - the density passing through the light
// Nothing shares a period with anything else, so the field churns rather than
// looping, and no two lines are ever at the same moment of it.
const PLASMA_TINTS = ["#a855f7", "#c084fc", "#8b5cf6", "#9333ea", "#b06cf0", "#7e3ff2"];
// the blown-out centres - near-white with only a hint of the violet left in them
const PLASMA_CORES = ["#f3e8ff", "#efe0ff", "#ffffff", "#e9d5ff", "#f7efff"];
const PUFF_MIN = 4;
const PUFF_MAX = 6;

export function plasmaPuffMarkup() {
	const count = PUFF_MIN + ((Math.random() * (PUFF_MAX - PUFF_MIN + 1)) | 0);
	let html = "";
	for (let i = 0; i < count; i++) {
		// deliberately larger than the row is tall: a plume has no edge you can see, and
		// a blob small enough to read as a shape stops reading as volume.
		const size = Math.round(rnd(90, 190));
		const style = [
			`--p-x:${Math.round(rnd(-12, 68))}%`,
			`--p-y:${Math.round(rnd(15, 85))}%`,
			`--p-size:${size}px`,
			`--p-tint:${pick(PLASMA_TINTS)}`,
			`--p-core:${pick(PLASMA_CORES)}`,
			`--p-blur:${Math.round(rnd(10, 22))}px`,
			`--p-op:${rnd(0.42, 0.76).toFixed(2)}`,
			`--p-dx:${rnd(-26, 26).toFixed(1)}px`,
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
	return html;
}

// the plume surging: one dense billow that swells out of nowhere and thins away.
// Appended and removed like the rain squall, so it never disturbs the puffs it
// passes through - it just briefly gives them something much brighter to overlap.
// Kept to the lit half of the row, since that's where the plume lives.
export function plasmaSurgeMarkup() {
	return (
		`<span class="surge" style="` +
		`--ps-x:${Math.round(rnd(4, 55))}%;` +
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
	// the puffs carry their own timing (see plasmaPuffMarkup); these are the row's
	// ambient layers - the violet wash, the edge burn along the top and bottom, and
	// the lamp behind the plume, which drifts so the source isn't nailed to one spot.
	if (n === "plasma") {
		return {
			"--plasma-wash-dur": `${rnd(6.5, 12).toFixed(2)}s`,
			"--plasma-wash-delay": `-${rnd(0, 11).toFixed(2)}s`,
			"--plasma-wash-peak": rnd(0.62, 0.95).toFixed(2),
			"--plasma-lamp-x": `${Math.round(rnd(6, 34))}%`,
			"--plasma-lamp-dur": `${rnd(9, 17).toFixed(2)}s`,
			"--plasma-lamp-delay": `-${rnd(0, 16).toFixed(2)}s`,
			"--plasma-text-dur": `${rnd(4.5, 8.5).toFixed(2)}s`,
			"--plasma-text-delay": `-${rnd(0, 8).toFixed(2)}s`,
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
