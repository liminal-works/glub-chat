// Minecraft-style "&"-code chat formatting (client-specific, glub-only).
//
// The convention: "&c" turns text red, "&l" makes it bold, "&r" resets, etc -
// the same legacy codes plugins like EssentialsX use. Native bitchat clients
// know nothing about this, so we can't just put the codes in the event content
// (they'd leak as literal "&c" junk on every other client). Instead the wire
// event carries the STRIPPED plaintext in `content` (what native renders) and
// the raw coded text in a ["glub","rich",<raw>] tag (which native ignores and
// glub prioritizes). See app.js transmit()/renderEvent() for the wiring, and
// the strip(rich)===content guard that keeps a tampered tag from rendering
// something other than the visible plaintext.
//
// Static colors + bold/italic/underline/strike + reset, plus two animated
// codes: &k obfuscated (text scrambles glyph-by-glyph) and &g rainbow (a hue
// gradient flows through the run). The animated codes only tag the run with a
// class here (fmtObf / fmtRainbow); the motion itself lives in app.js's
// animation loop (scrambling) and css (the rainbow gradient) - this module
// stays pure and DOM-free so it can be tested in isolation.

// Legacy Minecraft color slots 0-9 a-f, but tuned to stay legible on glub's
// OLED-black background: the darkest few (black/dark-blue/dark-red/dark-gray)
// are lifted off pure values so they read against black instead of vanishing.
// "&0" is the darkest swatch that's still visible - true #000 would be invisible.
const COLORS = {
	"0": "#48484f", // black -> dark slate (legible on black)
	"1": "#4a5bd6", // dark blue (lifted)
	"2": "#3fb950", // dark green (lifted)
	"3": "#2dd4bf", // dark aqua
	"4": "#e5484d", // dark red (lifted)
	"5": "#c74ddb", // dark purple
	"6": "#f0a020", // gold
	"7": "#a0a0a8", // gray
	"8": "#6e6e78", // dark gray
	"9": "#5b8dff", // blue
	a: "#55ff77", // green
	b: "#55ffff", // aqua
	c: "#ff6a6a", // red
	d: "#ff77ff", // light purple
	e: "#ffe45e", // yellow
	f: "#ffffff", // white
};

// non-color format codes. l/m/n/o are the static text decorations; k and g are
// the animated pair (obfuscated / rainbow) whose motion app.js + css drive.
const FORMATS = new Set(["l", "m", "n", "o"]); // bold / strikethrough / underline / italic
const OBFUSCATE = "k"; // scrambling "magic" text
const RAINBOW = "g"; // flowing hue gradient
const RESET = "r";

// a char is a recognized code iff it's a color, a format, animated, or reset.
// Uppercase never matches, so acronyms ("Q&A", "AT&T") are safe even at a boundary.
function isCodeChar(ch) {
	return (
		Object.prototype.hasOwnProperty.call(COLORS, ch) ||
		FORMATS.has(ch) ||
		ch === OBFUSCATE ||
		ch === RAINBOW ||
		ch === RESET
	);
}

// Single-pass tokenizer shared by stripFormat + renderFormat so the two can
// never disagree about what's a code. Yields {t:"text",v} | {t:"code",c}.
//
// "&&" is a literal ampersand. Otherwise "&X" is a code ONLY when the "&" sits
// at a real boundary: string start, right after whitespace, or right after
// another code (so chains like "&c&lTEXT" work). A "&" wedged between other
// characters is literal - this is what keeps "Q&A", "R&B", "M&M", "black&decker"
// from being mangled into color codes.
function tokenize(raw) {
	const s = String(raw || "");
	const tokens = [];
	let text = "";
	let afterCode = false;
	const flush = () => {
		if (text) {
			tokens.push({ t: "text", v: text });
			text = "";
		}
	};
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "&" && i + 1 < s.length) {
			const next = s[i + 1];
			if (next === "&") {
				text += "&"; // "&&" -> literal "&"
				i += 2;
				afterCode = false;
				continue;
			}
			const atBoundary = i === 0 || /\s/.test(s[i - 1]) || afterCode;
			if (atBoundary && isCodeChar(next)) {
				flush();
				tokens.push({ t: "code", c: next });
				i += 2;
				afterCode = true;
				continue;
			}
		}
		text += ch;
		i++;
		afterCode = false;
	}
	flush();
	return tokens;
}

// raw coded text -> the plaintext a native client sees (codes removed, "&&"
// collapsed to "&"). This is exactly what we put in the event `content`, and
// what the receive-side guard re-derives to authenticate a rich tag.
export function stripFormat(raw) {
	let out = "";
	for (const tok of tokenize(raw)) if (tok.t === "text") out += tok.v;
	return out;
}

// true if `raw` carries any code or escape - i.e. stripping changes it, so it's
// worth attaching a rich tag. A message with a bare "&" (e.g. "fish & chips")
// strips to itself and returns false, so no tag is sent.
export function hasFormat(raw) {
	return stripFormat(raw) !== String(raw || "");
}

const BLANK = { color: null, bold: false, italic: false, underline: false, strike: false, obf: false, rainbow: false };

// the Minecraft legacy rule: a solid color code clears every other flag (incl.
// our animated ones); a format code adds one; reset clears everything. Rainbow
// (&g) acts like a color but leaves the static text decorations alone, so
// "&l&gBOLD RAINBOW" and "&g&lBOLD RAINBOW" both work. Applied per code token.
function applyCode(state, c) {
	if (c === RESET) return { ...BLANK };
	if (Object.prototype.hasOwnProperty.call(COLORS, c)) {
		return { ...BLANK, color: COLORS[c] };
	}
	const next = { ...state };
	if (c === "l") next.bold = true;
	else if (c === "o") next.italic = true;
	else if (c === "n") next.underline = true;
	else if (c === "m") next.strike = true;
	else if (c === OBFUSCATE) next.obf = true;
	else if (c === RAINBOW) {
		next.rainbow = true;
		next.color = null; // the gradient supplies the color
	}
	return next;
}

function styleFor(state) {
	let style = "";
	if (!state.rainbow && state.color) style += `color:${state.color};`; // rainbow's color comes from css
	if (state.bold) style += "font-weight:700;";
	if (state.italic) style += "font-style:italic;";
	const deco = [];
	if (state.underline) deco.push("underline");
	if (state.strike) deco.push("line-through");
	if (deco.length) style += `text-decoration:${deco.join(" ")};`;
	return style;
}

function classFor(state) {
	const cls = [];
	if (state.rainbow) cls.push("fmtRainbow");
	if (state.obf) cls.push("fmtObf");
	return cls.join(" ");
}

// raw coded text -> safe html. Each plaintext run is passed through `bodyFn`
// (app.js's richBody: escape + linkify + payment chips) so urls/#geo/tokens
// still work inside colored text; the styled runs are wrapped in a span. A run
// with no active styling emits no wrapper, so it inherits the sender's normal
// peer color from the parent .msg span (matches "text before the first code").
// Animated runs get a class (fmtObf/fmtRainbow) that app.js + css bring to life.
export function renderFormat(raw, bodyFn) {
	const esc = typeof bodyFn === "function" ? bodyFn : (s) => s;
	let state = { ...BLANK };
	let html = "";
	for (const tok of tokenize(raw)) {
		if (tok.t === "code") {
			state = applyCode(state, tok.c);
			continue;
		}
		const inner = esc(tok.v);
		const style = styleFor(state);
		const cls = classFor(state);
		if (!style && !cls) {
			html += inner;
			continue;
		}
		let attrs = "";
		if (cls) attrs += ` class="${cls}"`;
		if (style) attrs += ` style="${style}"`;
		html += `<span${attrs}>${inner}</span>`;
	}
	return html;
}
