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

export const FLAIRS = ["fire", "lightning", "stars"];

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
const FX_FLAIRS = new Set(["stars", "lightning"]);

export function flairHasFx(raw) {
	return FX_FLAIRS.has(flairName(raw));
}

// cool white-blues, so a field reads as starlight rather than confetti
const STAR_TINTS = ["#ffffff", "#ffffff", "#cfe6ff", "#a8ccff", "#dbe9ff", "#bcd8ff", "#e9f2ff"];

// one 2px dot is cloned into a whole field by box-shadow, so a random field is
// just a random offset list - still a single composited layer. X advances by a
// jittered step rather than being uniformly random, which keeps stars from
// clumping the way pure noise does.
function starField(count, step, jitterY) {
	const out = [];
	let x = 0;
	for (let i = 0; i < count; i++) {
		x += rnd(step * 0.55, step * 1.45);
		out.push(`${Math.round(x)}px ${Math.round(rnd(-jitterY, jitterY))}px ${pick(STAR_TINTS)}`);
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
	return (
		`<span class="boltFlash"></span>` +
		`<svg class="boltSvg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">` +
		`<polyline class="boltGlow" points="${main}"/><polyline class="boltCore" points="${main}"/>${fork}` +
		`</svg>`
	);
}

// the CSS custom properties a flaired line wants, as { "--name": value }. Unknown
// or var-less flairs get {} - the stylesheet carries fallbacks for every var, so a
// line (or a /flair preview chip) with no vars set still renders correctly.
export function flairVars(raw) {
	const n = flairName(raw);
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
	if (n !== "stars") return {};
	return {
		// two independent fields: a denser one up top, a sparser one lower down
		"--star-a-field": starField(7, 46, 11),
		"--star-b-field": starField(5, 60, 12),
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
