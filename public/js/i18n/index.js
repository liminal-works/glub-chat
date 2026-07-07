// tiny client-side i18n engine. no deps, no build step. english is statically
// imported so the app boots synchronously in english (the fallback); other
// locales are dynamic-imported on demand to keep the initial payload small.
//
// the browser hands us the hard parts for free, the same way iOS hands them to
// native bitchat: Intl.PluralRules for plural categories, Intl.RelativeTimeFormat
// for locale-correct "x ago", navigator.languages for detection. all we add is
// key -> string resolution + {placeholder} interpolation.
import en from "./en.js";

const FALLBACK = "en";
const STORAGE_KEY = "glub_locale"; // optional manual override (no UI yet)

// registry of additional locales: code -> async loader. add a language by
// dropping a `<code>.js` dictionary next to en.js and registering it here, e.g.
//   es: () => import("./es.js").then((m) => m.default),
const LOADERS = {};

// scripts that read right-to-left, so we can flip <html dir> for them
const RTL = new Set(["ar", "fa", "he", "ur"]);

const dicts = { en };
let locale = FALLBACK;
let dict = en;
let plural = new Intl.PluralRules(FALLBACK);
let rtf = new Intl.RelativeTimeFormat(FALLBACK, { numeric: "always", style: "narrow" });
const changeCbs = [];

function get(obj, key) {
	return key.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

// resolve a key against the active dict, then english, then the key itself.
function lookup(key) {
	const v = get(dict, key);
	return v != null ? v : get(en, key) != null ? get(en, key) : key;
}

function interpolate(str, vars) {
	if (!vars || typeof str !== "string") return str;
	return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

// translate a key. pluralized entries (objects of { one, other, ... }) are
// selected via Intl.PluralRules using vars.count; everything supports {placeholder}
// interpolation from vars.
export function t(key, vars) {
	let val = lookup(key);
	if (val && typeof val === "object") {
		const n = vars && typeof vars.count === "number" ? vars.count : 0;
		val = val[plural.select(n)] != null ? val[plural.select(n)] : val.other != null ? val.other : val.one;
		if (val == null) return key;
	}
	return interpolate(val, vars);
}

// locale-correct compact relative time ("now", "5s ago", "3m ago", "2h ago",
// "4d ago") from an epoch-seconds timestamp.
export function formatAgo(tsSeconds) {
	const s = Math.max(0, Math.floor(Date.now() / 1000) - tsSeconds);
	if (s < 5) return t("time.now");
	let value, unit;
	if (s < 60) [value, unit] = [s, "second"];
	else if (s < 3600) [value, unit] = [Math.floor(s / 60), "minute"];
	else if (s < 86400) [value, unit] = [Math.floor(s / 3600), "hour"];
	else [value, unit] = [Math.floor(s / 86400), "day"];
	return rtf.format(-value, unit);
}

export function getLocale() {
	return locale;
}

// the language the user actually wants to READ, independent of ui coverage.
// getLocale() can only ever be a language we've shipped a dictionary for, but
// content translation (the tap-menu "translate" action) supports far more
// targets than the ui does - so it asks for this instead: the manual override
// if set, else the browser's top preference, as a full tag ("pt-BR", not "pt";
// providers like DeepL want the region for pt/en/zh).
export function preferredContentLanguage() {
	const stored = (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "";
	if (stored) return stored;
	if (typeof navigator !== "undefined") {
		if (navigator.languages && navigator.languages.length) return navigator.languages[0];
		if (navigator.language) return navigator.language;
	}
	return FALLBACK;
}

export function onLocaleChange(cb) {
	changeCbs.push(cb);
}

// pick the best supported locale: a stored override, else the browser's ordered
// language preferences, else english.
export function detectLocale() {
	const stored = (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "";
	const prefs = stored
		? [stored]
		: typeof navigator !== "undefined" && navigator.languages && navigator.languages.length
		? navigator.languages
		: [(typeof navigator !== "undefined" && navigator.language) || FALLBACK];
	for (const l of prefs) {
		const base = String(l).toLowerCase().split("-")[0];
		if (base === FALLBACK || LOADERS[base]) return base;
	}
	return FALLBACK;
}

async function ensureDict(code) {
	if (dicts[code]) return dicts[code];
	const loader = LOADERS[code];
	if (!loader) return null;
	try {
		dicts[code] = await loader();
		return dicts[code];
	} catch {
		return null; // load failed - caller falls back to english
	}
}

// fill static markup: [data-i18n] -> textContent, [data-i18n-placeholder] ->
// placeholder, and the few css-generated labels exposed as custom properties
// (css content: var(--label-*)).
export function applyStaticDom() {
	if (typeof document === "undefined") return;
	for (const el of document.querySelectorAll("[data-i18n]")) {
		el.textContent = t(el.getAttribute("data-i18n"));
	}
	for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
		el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
	}
	const root = document.documentElement.style;
	root.setProperty("--label-toggle-on", JSON.stringify(t("settings.toggle_on")));
	root.setProperty("--label-toggle-off", JSON.stringify(t("settings.toggle_off")));
	root.setProperty("--label-no-users", JSON.stringify(t("users.empty")));
	root.setProperty("--label-dm-empty", JSON.stringify(t("dm.empty")));
	root.setProperty("--label-no-convos", JSON.stringify(t("dm.no_conversations")));
}

// switch the active locale (loading its dictionary if needed), update the Intl
// formatters + <html lang/dir>, refill static markup, and notify listeners so
// dynamic views re-render in the new language.
export async function setLocale(code) {
	const base = String(code || "").toLowerCase().split("-")[0];
	const target = base === FALLBACK || LOADERS[base] ? base : FALLBACK;
	const d = target === FALLBACK ? en : await ensureDict(target);

	locale = d ? target : FALLBACK;
	dict = d || en;
	plural = new Intl.PluralRules(locale);
	rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });

	if (typeof document !== "undefined") {
		document.documentElement.lang = locale;
		document.documentElement.dir = RTL.has(locale) ? "rtl" : "ltr";
	}
	applyStaticDom();
	for (const cb of changeCbs) cb();
}
