// theme registry + runtime switcher for the /theme command.
//
// a theme is a small palette (the eight core colors in style.css's :root) plus
// optional surface-tuning overrides (scanlines, scrim, input fills - mainly for
// the light themes) and an identity recipe:
//   band - constrains per-user name colors to a themed hue range (hue/spread in
//          degrees, sat/bri 0-100). null = bitchat's native full-wheel hashing.
//   self - the reserved "you" color. null = bitchat's system orange.
// every var not named by a theme falls back to the bitchat default, so switching
// themes never leaves residue behind.

const STORAGE_THEME_KEY = "glub_theme";

// the full set of theme-controllable vars, at their bitchat (default) values.
// applyTheme always writes every key, merging the active theme over this.
const BASE_VARS = {
	"--bg": "#000000",
	"--fg": "#8fe89c",
	"--muted": "#7a828c",
	"--geo": "#5cb3ff",
	"--accent": "#30d158",
	"--danger": "#ff7b72",
	"--chrome-bg": "#000000",
	"--scanline-color": "rgba(0, 0, 0, 0.16)",
	"--vignette-color": "rgba(0, 0, 0, 0.32)",
	"--scrim": "rgba(0, 0, 0, 0.82)",
	"--selection-fg": "#eaffea",
	"--field-bg": "rgba(0, 0, 0, 0.18)",
	"--overlay-fg": "rgba(255, 255, 255, 0.92)",
	"--overlay-shadow": "0 1px 2px rgba(0, 0, 0, 0.45)",
	"--bubble-theirs": "rgba(255, 255, 255, 0.03)",
};

// shared tuning for the two light themes: fainter CRT glass, a bright scrim,
// dark-on-light inputs and overlays.
const LIGHT_VARS = {
	"--scanline-color": "rgba(0, 0, 0, 0.05)",
	"--vignette-color": "rgba(0, 0, 0, 0.10)",
	"--field-bg": "rgba(0, 0, 0, 0.06)",
	"--overlay-fg": "rgba(0, 0, 0, 0.75)",
	"--overlay-shadow": "none",
	"--bubble-theirs": "rgba(0, 0, 0, 0.05)",
};

export const THEMES = [
	{
		// native bitchat: black phosphor green, blue channels, orange you.
		name: "bitchat",
		vars: {},
		band: null, // full-wheel bitchat hashing
		self: null, // system orange
	},
	{
		// blade runner 2049: joi's blossom pink against K's violet LA haze; you
		// glow in the orange of the vegas ruins.
		name: "blade-runner-blossom",
		vars: {
			"--bg": "#0a0712",
			"--fg": "#e4d9f2",
			"--muted": "#857a9e",
			"--geo": "#b48cff",
			"--accent": "#ff6ac2",
			"--chrome-bg": "#100b1c",
			"--selection-fg": "#ffeaf6",
		},
		band: { hue: 290, spread: 80, sat: 72, bri: 96 },
		self: "#ffa04d",
	},
	{
		// cyberpunk 2077 UX: the menu/HUD's signature yellow chrome and cyan data
		// readouts on near-black, with the alert-red danger state. channels glow
		// cyan; the chat crowd fans across the UI's wide cyan->azure "scan" palette
		// (the prototype's cyan band), and you stand out in V's interactive yellow.
		name: "cyberpunk-2077",
		vars: {
			"--bg": "#08090e",
			"--fg": "#cdd6db",
			"--muted": "#767c86",
			"--geo": "#2de2e6",
			"--accent": "#fcee0a",
			"--danger": "#ff003c",
			"--chrome-bg": "#0e0f16",
			"--selection-fg": "#fffde0",
		},
		band: { hue: 195, spread: 95, sat: 85, bri: 95 },
		self: "#fcee0a",
	},
	{
		// ex machina: the lab's red emergency lighting during the power cuts;
		// danger becomes an amber alarm (red is the ambient), you are ava-white.
		name: "ex-machina",
		vars: {
			"--bg": "#0b0507",
			"--fg": "#f2d9d9",
			"--muted": "#93706e",
			"--geo": "#ff8a5c",
			"--accent": "#ff3b30",
			"--danger": "#ffd60a",
			"--chrome-bg": "#150809",
			"--selection-fg": "#ffecec",
		},
		band: { hue: 5, spread: 26, sat: 85, bri: 98 },
		self: "#f2f2f2",
	},
	{
		// dune part two, giedi prime: the black sun's infrared monochrome - a
		// world with no color at all. everyone is a shade of gray; you burn white.
		name: "giedi-prime",
		vars: {
			"--bg": "#050505",
			"--fg": "#ededed",
			"--muted": "#878787",
			"--geo": "#bdbdbd",
			"--accent": "#e6e6e6",
			"--chrome-bg": "#0e0e0e",
			"--selection-fg": "#ffffff",
		},
		band: { hue: 0, spread: 0, sat: 0, bri: 80 },
		self: "#ffffff",
	},
	{
		// the matrix: code-rain green on void black; the One reads as white light.
		name: "matrix-neo",
		vars: {
			"--bg": "#020703",
			"--fg": "#a8ffb8",
			"--muted": "#567d62",
			"--geo": "#7dffcf",
			"--accent": "#00ff66",
			"--chrome-bg": "#051006",
			"--selection-fg": "#eaffea",
		},
		band: { hue: 135, spread: 28, sat: 85, bri: 95 },
		self: "#f2fff5",
	},
	{
		// guardians of the galaxy: quill's amber-gold 70s haze, milano engine
		// cyan for chrome, and the mask's glowing cyan for you.
		name: "star-lord",
		vars: {
			"--bg": "#0c0806",
			"--fg": "#f2ddb8",
			"--muted": "#8e7d67",
			"--geo": "#ff8c42",
			"--accent": "#3fd8ff",
			"--chrome-bg": "#151009",
			"--selection-fg": "#eafaff",
		},
		band: { hue: 38, spread: 26, sat: 85, bri: 98 },
		self: "#62e0ff",
	},
	{
		// loki's TVA: mid-century amber CRTs and miss minutes orange; you are the
		// seafoam teal of the office walls.
		name: "time-variance-amber",
		vars: {
			"--bg": "#0b0906",
			"--fg": "#ffd98c",
			"--muted": "#97845f",
			"--geo": "#ffc861",
			"--accent": "#ff9e1f",
			"--danger": "#ff6b5e",
			"--chrome-bg": "#141009",
			"--selection-fg": "#fff3d9",
		},
		band: { hue: 38, spread: 24, sat: 88, bri: 99 },
		self: "#7fe8d9",
	},
	{
		// tron legacy: the grid's ice blue and identity-disc cyan; you carry
		// clu's orange.
		name: "tron-legacy",
		vars: {
			"--bg": "#04070c",
			"--fg": "#cdeeff",
			"--muted": "#5f7f8e",
			"--geo": "#5ce1ff",
			"--accent": "#00b8ff",
			"--chrome-bg": "#081119",
			"--selection-fg": "#eaf9ff",
		},
		band: { hue: 200, spread: 26, sat: 80, bri: 98 },
		self: "#ffab24",
	},
	{
		// severance: lumon's milky office light and MDR terminal teal; you are
		// kier's burnt orange. (light theme)
		name: "lumon-light",
		vars: {
			...LIGHT_VARS,
			"--bg": "#eef0ea",
			"--fg": "#24424a",
			"--muted": "#6c8189",
			"--geo": "#2f7d97",
			"--accent": "#106a74",
			"--danger": "#b3362b",
			"--chrome-bg": "#e3e8e1",
			"--scrim": "rgba(230, 235, 228, 0.88)",
			"--selection-fg": "#143c42",
		},
		band: { hue: 200, spread: 34, sat: 45, bri: 55 },
		self: "#b3552e",
	},
	{
		// her: theodore's coral-and-cream world; you answer in samantha's calm
		// dusty blue. (light theme)
		name: "her-light",
		vars: {
			...LIGHT_VARS,
			"--bg": "#f7efe6",
			"--fg": "#6b4a3f",
			"--muted": "#a2867a",
			"--geo": "#b04a36",
			"--accent": "#e0654f",
			"--danger": "#a63324",
			"--chrome-bg": "#f0e4d6",
			"--scrim": "rgba(247, 239, 230, 0.88)",
			"--selection-fg": "#4a2f28",
		},
		band: { hue: 14, spread: 22, sat: 52, bri: 62 },
		self: "#6f8fa6",
	},
];

let active = THEMES[0];

export function themeNames() {
	return THEMES.map((t) => t.name);
}

export function activeTheme() {
	return active;
}

// "#rrggbb" -> { r, g, b }, for the themed self color
export function hexToRgb(hex) {
	const n = parseInt(hex.slice(1), 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// applies a theme by name (exact match). returns the applied theme, or null if
// the name is unknown (and changes nothing).
export function applyTheme(name) {
	const theme = THEMES.find((t) => t.name === name);
	if (!theme) return null;
	active = theme;
	const root = document.documentElement.style;
	// write the full var set every time so no previous theme's values linger
	for (const [key, base] of Object.entries(BASE_VARS)) {
		root.setProperty(key, theme.vars[key] ?? base);
	}
	// keep the browser UI (address bar / status bar) matched to the page
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.content = theme.vars["--bg"] ?? BASE_VARS["--bg"];
	return theme;
}

export function persistTheme(name) {
	localStorage.setItem(STORAGE_THEME_KEY, name);
}

// boot: re-apply the saved theme (silently falls back to bitchat)
export function initTheme() {
	const saved = localStorage.getItem(STORAGE_THEME_KEY);
	if (saved && saved !== THEMES[0].name) applyTheme(saved);
}
