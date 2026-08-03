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
// codes: &k obfuscated (text scrambles glyph-by-glyph) and &g a flowing gradient
// (rainbow by default, retuned by your equipped flair - see RAINBOW below). The animated codes only tag the run with a
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
// &g is a wildcard gradient: rainbow on its own, but retuned to your equipped
// flair's palette when you have one (fire reads as embers, lightning as electric
// arc, ...). Purely a css concern - see .fmtRainbow and its .flair-* overrides -
// so this module just marks the run and the row's flair class does the rest.
const RAINBOW = "g";
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

// One emoji as a READER counts them, not as code points: a flag is two regional
// indicators, a family is several pictographs joined by ZWJ, a skin tone is a
// modifier, a keycap is a digit plus U+20E3. Splitting on code points would tear a
// "👨‍👩‍👧‍👦" into pieces and paint half of it.
export const EMOJI_SEQ_RE =
	/\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]️?⃣/gu;

// Single-pass tokenizer shared by stripFormat + renderFormat so the two can
// never disagree about what's a code. Yields {t:"text",v} | {t:"code",c}.
//
// Minecraft-faithful: ANY "&x" where x is a code char is a code, anywhere in the
// string - no boundary rule - so codes stack/chain freely mid-word, e.g. the
// per-letter rainbow "&4r&ca&6i&en&ab&9o&dw". "&&" is a literal ampersand (our
// one escape - type it to keep a real "&code", e.g. "black&&decker"). Codes are
// lowercase only, so uppercase acronyms ("Q&A", "R&B", "M&M", "AT&T") are never
// touched; a lowercase "&code" run mid-word ("q&a", "black&decker") does format,
// matching how Minecraft/EssentialsX behave.
function tokenize(raw) {
	const s = String(raw || "");
	const tokens = [];
	let text = "";
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
				continue;
			}
			if (isCodeChar(next)) {
				flush();
				tokens.push({ t: "code", c: next });
				i += 2;
				continue;
			}
		}
		text += ch;
		i++;
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

const BLANK = {
	color: null,
	bold: false,
	italic: false,
	underline: false,
	strike: false,
	obf: false,
	rainbow: false,
};

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
	// -webkit-text-fill-color alongside color, because a colored run can end up
	// NESTED inside a gradient run - a "/format ...&g{msg}" template wraps the whole
	// message in .fmtRainbow, which paints glyphs by setting the fill to transparent.
	// That property inherits and outranks a descendant's `color`, so without matching
	// it here an explicitly-coloured "&chello" inside such a template would render in
	// the template's gradient instead of red. Uncoloured runs still inherit the
	// gradient, which is what makes "&g{msg}" work in the first place.
	if (!state.rainbow && state.color) style += `color:${state.color};-webkit-text-fill-color:${state.color};`;
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

// does this run's styling paint the glyphs themselves? Only those two do: bold,
// italic and the underlines leave a colour font perfectly intact, so a run carrying
// nothing else needs no emoji handling at all.
function paintsGlyphs(state) {
	return !!state.color || !!state.rainbow;
}

// Wrap the emoji inside a painted run so the paint doesn't reach them.
//
// Split BEFORE bodyFn rather than after: bodyFn returns html, and finding emoji in
// html means finding them inside attributes too - the ️ in a title, the flag in a
// url - where a wrapper would corrupt the markup. Splitting the plaintext first
// means every piece handed to bodyFn is still plaintext, and the emoji pieces only
// ever need escaping since a url can't be made of emoji.
function renderRunSplittingEmoji(text, esc) {
	EMOJI_SEQ_RE.lastIndex = 0;
	let out = "";
	let at = 0;
	for (let m = EMOJI_SEQ_RE.exec(text); m; m = EMOJI_SEQ_RE.exec(text)) {
		if (m.index > at) out += esc(text.slice(at, m.index));
		out += `<span class="fmtEmoji">${escapeHtml(m[0])}</span>`;
		at = m.index + m[0].length;
	}
	if (at < text.length) out += esc(text.slice(at));
	return out;
}

// emoji carry no markup, so this is only here to keep a stray "&" or "<" from a
// malformed sequence out of the html.
function escapeHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// raw coded text -> safe html. Each plaintext run is passed through `bodyFn`
// (app.js's richBody: escape + linkify + payment chips) so urls/#geo/tokens
// still work inside colored text; the styled runs are wrapped in a span. A run
// with no active styling emits no wrapper, so it inherits the sender's normal
// peer color from the parent .msg span (matches "text before the first code").
// Animated runs get a class (fmtObf/fmtRainbow) that app.js + css bring to life.
//
// `spareEmoji` decides whether emoji are protected from the paint. A colour is
// applied with -webkit-text-fill-color and &g paints glyphs through a clipped
// gradient; both overrule a colour font, so an emoji caught in a painted run comes
// out as a flat silhouette. That is a real effect and a poor accident, and which one
// it is depends entirely on WHERE the codes were written:
//
//   a message      codes typed alongside what you're saying. "&ahello 🎉" means a
//                  green hello and a party popper, so emoji are spared. (default)
//   a /format      your standing line style, chosen once and deliberately. A
//                  silhouette there is the look you picked, so it's left alone.
//
// Note this only governs emoji in the run being rendered. A template's `{msg}` is
// substituted after the fact, so a message inside a "&g{msg}" template inherits the
// gradient through css - and its own emoji are protected by whatever the message
// render decided, which is the split above working exactly as intended.
export function renderFormat(raw, bodyFn, { spareEmoji = true } = {}) {
	const esc = typeof bodyFn === "function" ? bodyFn : (s) => s;
	let state = { ...BLANK };
	let html = "";
	for (const tok of tokenize(raw)) {
		if (tok.t === "code") {
			state = applyCode(state, tok.c);
			continue;
		}
		const style = styleFor(state);
		const cls = classFor(state);
		const inner =
			spareEmoji && paintsGlyphs(state) ? renderRunSplittingEmoji(tok.v, esc) : esc(tok.v);
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
