import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Ephemeral media hosting for chat uploads. Every upload is REBUILT, not just
// "stripped": the sanitizers below walk the container format and emit a new file
// containing only the blocks needed to render (image data, palettes, animation
// control). Anything else - EXIF/GPS, XMP, comments, text chunks, timestamps,
// unknown blocks - simply isn't copied. This must happen server-side even though
// the glub client already re-encodes via canvas, because the endpoint is public:
// a direct POST could otherwise smuggle a metadata-laden file into our hosting.
//
// Storage is a flat temp dir, wiped on boot (this is 24h ephemeral hosting, not
// a library). Bounded two ways: a TTL, and a hard item cap that prunes oldest.
const TTL_MS = 24 * 60 * 60_000; // each item lives at most this long
const SWEEP_MS = 10 * 60_000; // expiry sweep cadence

export function createMediaStore({ dir, maxItems = 50 }) {
	const items = []; // insertion-ordered: [{ file, at }]

	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });

	function removeFile(file) {
		try {
			fs.unlinkSync(path.join(dir, file));
		} catch {
			// already gone
		}
	}

	function prune() {
		const cutoff = Date.now() - TTL_MS;
		while (items.length && (items.length > maxItems || items[0].at < cutoff)) {
			removeFile(items.shift().file);
		}
	}

	setInterval(prune, SWEEP_MS).unref();

	// sanitize + store a buffer; returns the stored filename or null if the
	// payload isn't a valid file of the declared type.
	function put(buf, mime) {
		const format = FORMATS[mime];
		if (!format) return null;
		let clean;
		try {
			clean = format.rebuild(buf);
		} catch {
			return null;
		}
		if (!clean) return null;

		const file = `${crypto.randomBytes(8).toString("hex")}.${format.ext}`;
		fs.writeFileSync(path.join(dir, file), clean);
		items.push({ file, at: Date.now() });
		prune(); // enforce the cap immediately, not on the next sweep
		return file;
	}

	// resolve a stored filename to { path, mime }, or null (unknown/expired).
	function get(file) {
		if (!/^[0-9a-f]{16}\.(jpg|png|gif)$/.test(file)) return null;
		const item = items.find((i) => i.file === file);
		if (!item || item.at < Date.now() - TTL_MS) return null;
		const ext = file.split(".")[1];
		const mime = ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : "image/gif";
		return { path: path.join(dir, file), mime };
	}

	function stats() {
		return { items: items.length, maxItems };
	}

	return { put, get, stats };
}

// --- format rebuilders ---------------------------------------------------

const FORMATS = {
	"image/jpeg": { ext: "jpg", rebuild: rebuildJpeg },
	"image/png": { ext: "png", rebuild: rebuildPng },
	"image/gif": { ext: "gif", rebuild: rebuildGif },
};

// JPEG: copy only the structural segments. All APPn (EXIF/JFIF/XMP/etc) and COM
// segments are dropped; from SOS onward is entropy-coded image data, copied as-is.
function rebuildJpeg(buf) {
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	const out = [Buffer.from([0xff, 0xd8])];
	let i = 2;
	while (i + 4 <= buf.length) {
		if (buf[i] !== 0xff) return null;
		const marker = buf[i + 1];
		if (marker === 0xda) {
			out.push(buf.subarray(i)); // SOS: scan data runs to EOI - copy the rest
			return Buffer.concat(out);
		}
		const len = buf.readUInt16BE(i + 2);
		if (len < 2 || i + 2 + len > buf.length) return null;
		const isApp = marker >= 0xe0 && marker <= 0xef;
		const isComment = marker === 0xfe;
		if (!isApp && !isComment) out.push(buf.subarray(i, i + 2 + len));
		i += 2 + len;
	}
	return null; // never reached SOS - not a decodable jpeg
}

// PNG: copy only whitelisted chunks - structure, palette, transparency, color
// hints, image data, and APNG animation control. tEXt/zTXt/iTXt/eXIf/tIME etc
// are dropped.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "gAMA", "sRGB", "IDAT", "IEND", "acTL", "fcTL", "fdAT"]);

function rebuildPng(buf) {
	if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
	const out = [PNG_SIG];
	let i = 8;
	let sawEnd = false;
	while (i + 12 <= buf.length) {
		const len = buf.readUInt32BE(i);
		const type = buf.subarray(i + 4, i + 8).toString("latin1");
		const end = i + 12 + len;
		if (end > buf.length) return null;
		if (PNG_KEEP.has(type)) out.push(buf.subarray(i, end));
		i = end;
		if (type === "IEND") {
			sawEnd = true;
			break;
		}
	}
	return sawEnd ? Buffer.concat(out) : null;
}

// GIF: copy header/screen descriptor/palettes, image blocks, graphic-control
// extensions (frame timing) and the NETSCAPE looping extension. Comment, plain
// text, and any other application extensions are dropped.
function rebuildGif(buf) {
	const magic = buf.subarray(0, 6).toString("latin1");
	if (magic !== "GIF87a" && magic !== "GIF89a") return null;
	if (buf.length < 13) return null;

	const flags = buf[10];
	const gctBytes = flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0;
	let i = 13 + gctBytes;
	if (i > buf.length) return null;
	const out = [buf.subarray(0, i)];

	// advances past a chain of data sub-blocks, returning the index after the
	// 0x00 terminator (or -1 on truncation).
	function skipSubBlocks(at) {
		while (at < buf.length) {
			const size = buf[at];
			if (size === 0) return at + 1;
			at += 1 + size;
		}
		return -1;
	}

	while (i < buf.length) {
		const b = buf[i];
		if (b === 0x3b) {
			out.push(buf.subarray(i, i + 1)); // trailer
			return Buffer.concat(out);
		}
		if (b === 0x2c) {
			// image descriptor + optional local color table + LZW data sub-blocks
			if (i + 10 > buf.length) return null;
			const lflags = buf[i + 9];
			const lctBytes = lflags & 0x80 ? 3 * 2 ** ((lflags & 0x07) + 1) : 0;
			const dataStart = i + 10 + lctBytes + 1; // +1 = LZW minimum code size byte
			const next = skipSubBlocks(dataStart);
			if (next === -1) return null;
			out.push(buf.subarray(i, next));
			i = next;
			continue;
		}
		if (b === 0x21) {
			if (i + 2 > buf.length) return null;
			const label = buf[i + 1];
			const next = skipSubBlocks(i + 2);
			if (next === -1) return null;
			const isGraphicControl = label === 0xf9;
			const isNetscapeLoop =
				label === 0xff &&
				buf[i + 2] === 11 &&
				buf.subarray(i + 3, i + 14).toString("latin1") === "NETSCAPE2.0";
			if (isGraphicControl || isNetscapeLoop) out.push(buf.subarray(i, next));
			i = next;
			continue;
		}
		return null; // unknown block type - refuse rather than guess
	}
	return null; // no trailer
}
