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
