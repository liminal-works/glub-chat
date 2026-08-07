// A deliberately narrow EXIF reader: where a photo was taken, and when.
//
// Four tags, not a metadata library. exifr does this and much more in ~1.2mb; the
// four fields below are the whole requirement, and a geotagged post that silently
// guesses is worse than one that refuses, so the parsing needs to be something we
// can read end to end rather than trust.
//
// JPEG only. A browser file input hands back JPEG for essentially every camera
// photo (ios transcodes HEIC on upload), and PNG has no standard GPS block - so
// anything else is reported as "no metadata" rather than parsed hopefully.

const APP1 = 0xffe1;
const SOI = 0xffd8;

// TIFF tag ids we care about, and nothing else.
const T_EXIF_IFD = 0x8769;
const T_GPS_IFD = 0x8825;
const T_DATETIME_ORIGINAL = 0x9003;
const T_OFFSET_TIME_ORIGINAL = 0x9011;
const G_LAT_REF = 1;
const G_LAT = 2;
const G_LON_REF = 3;
const G_LON = 4;

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

// Find the APP1 segment carrying "Exif\0\0" and return a view starting at the TIFF
// header inside it. Walks the marker chain rather than searching for the string,
// so a JPEG whose pixel data happens to contain "Exif\0\0" can't be misread.
function findTiff(bytes) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.byteLength < 4 || dv.getUint16(0) !== SOI) return null;
	let off = 2;
	while (off + 4 <= dv.byteLength) {
		const marker = dv.getUint16(off);
		if ((marker & 0xff00) !== 0xff00) return null; // out of sync; not a JPEG we understand
		const size = dv.getUint16(off + 2);
		if (size < 2) return null;
		if (marker === APP1) {
			const start = off + 4;
			// "Exif\0\0" then the TIFF header
			if (
				start + 6 <= dv.byteLength &&
				dv.getUint32(start) === 0x45786966 &&
				dv.getUint16(start + 4) === 0
			) {
				return { dv, tiff: start + 6 };
			}
		}
		// SOS: pixel data follows and metadata never appears after it
		if (marker === 0xffda) return null;
		off += 2 + size;
	}
	return null;
}

function readEntries(dv, tiff, ifd, little) {
	const out = [];
	if (ifd + 2 > dv.byteLength) return out;
	const n = dv.getUint16(ifd, little);
	// a corrupt count could otherwise walk us off the end of the buffer
	if (n > 512 || ifd + 2 + n * 12 > dv.byteLength) return out;
	for (let i = 0; i < n; i++) {
		const e = ifd + 2 + i * 12;
		const tag = dv.getUint16(e, little);
		const type = dv.getUint16(e + 2, little);
		const count = dv.getUint32(e + 4, little);
		const bytes = (TYPE_SIZE[type] || 0) * count;
		// values up to 4 bytes live inline; longer ones are a pointer into the TIFF block
		const at = bytes > 4 ? tiff + dv.getUint32(e + 8, little) : e + 8;
		out.push({ tag, type, count, at, bytes });
	}
	return out;
}

function readAscii(dv, entry) {
	if (entry.type !== 2 || entry.at + entry.count > dv.byteLength) return "";
	let s = "";
	for (let i = 0; i < entry.count; i++) {
		const c = dv.getUint8(entry.at + i);
		if (c === 0) break;
		s += String.fromCharCode(c);
	}
	return s.trim();
}

function readRationals(dv, entry, little) {
	if (entry.type !== 5 && entry.type !== 10) return [];
	if (entry.at + entry.count * 8 > dv.byteLength) return [];
	const out = [];
	for (let i = 0; i < entry.count; i++) {
		const o = entry.at + i * 8;
		const num = little ? dv.getUint32(o, true) : dv.getUint32(o);
		const den = little ? dv.getUint32(o + 4, true) : dv.getUint32(o + 4);
		out.push(den ? num / den : 0);
	}
	return out;
}

const dmsToDeg = (a) => (a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : NaN);

// "2008:10:22 16:28:39" -> the calendar fields, with NO timezone applied. EXIF
// records wall-clock time at the camera and says nothing about the offset, so
// turning this into an instant is the caller's problem (see exifTimestamp).
function parseExifDate(s) {
	const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ""));
	if (!m) return null;
	const [, y, mo, d, h, mi, sec] = m.map(Number);
	if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 60) return null;
	return { y, mo, d, h, mi, s: sec };
}

// "+02:00" / "-0500" / "Z" -> minutes east of UTC, or null.
export function parseUtcOffset(s) {
	const raw = String(s || "").trim();
	if (/^Z$/i.test(raw)) return 0;
	const m = /^([+-])(\d{2}):?(\d{2})$/.exec(raw);
	if (!m) return null;
	const mins = Number(m[2]) * 60 + Number(m[3]);
	if (Number(m[2]) > 14 || Number(m[3]) > 59) return null;
	return m[1] === "-" ? -mins : mins;
}

// The whole public surface: what a file says about where and when.
// Returns { lat, lon, taken, offsetMinutes } with any field null when absent.
export function readExif(bytes) {
	const found = findTiff(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
	const empty = { lat: null, lon: null, taken: null, offsetMinutes: null };
	if (!found) return empty;
	const { dv, tiff } = found;
	if (tiff + 8 > dv.byteLength) return empty;

	const order = dv.getUint16(tiff);
	if (order !== 0x4949 && order !== 0x4d4d) return empty;
	const little = order === 0x4949;
	if (dv.getUint16(tiff + 2, little) !== 42) return empty; // the TIFF magic

	const ifd0 = tiff + dv.getUint32(tiff + 4, little);
	const root = readEntries(dv, tiff, ifd0, little);

	let lat = null;
	let lon = null;
	let taken = null;
	let offsetMinutes = null;

	const gpsPtr = root.find((e) => e.tag === T_GPS_IFD);
	if (gpsPtr) {
		const gps = readEntries(dv, tiff, tiff + dv.getUint32(gpsPtr.at, little), little);
		const get = (tag) => gps.find((e) => e.tag === tag);
		const latE = get(G_LAT);
		const lonE = get(G_LON);
		if (latE && lonE) {
			const la = dmsToDeg(readRationals(dv, latE, little));
			const lo = dmsToDeg(readRationals(dv, lonE, little));
			const latRef = readAscii(dv, get(G_LAT_REF) || {}) || "N";
			const lonRef = readAscii(dv, get(G_LON_REF) || {}) || "E";
			if (Number.isFinite(la) && Number.isFinite(lo)) {
				const signedLat = /^S/i.test(latRef) ? -la : la;
				const signedLon = /^W/i.test(lonRef) ? -lo : lo;
				// 0,0 is where a camera writes "I had no fix" as often as it is the
				// Atlantic, and out-of-range values are a corrupt block
				const zeroIsland = Math.abs(signedLat) < 1e-9 && Math.abs(signedLon) < 1e-9;
				if (!zeroIsland && Math.abs(signedLat) <= 90 && Math.abs(signedLon) <= 180) {
					lat = signedLat;
					lon = signedLon;
				}
			}
		}
	}

	const exifPtr = root.find((e) => e.tag === T_EXIF_IFD);
	if (exifPtr) {
		const sub = readEntries(dv, tiff, tiff + dv.getUint32(exifPtr.at, little), little);
		const dto = sub.find((e) => e.tag === T_DATETIME_ORIGINAL);
		if (dto) taken = parseExifDate(readAscii(dv, dto));
		const off = sub.find((e) => e.tag === T_OFFSET_TIME_ORIGINAL);
		if (off) offsetMinutes = parseUtcOffset(readAscii(dv, off));
	}

	return { lat, lon, taken, offsetMinutes };
}

// Turn the wall-clock EXIF time into a real instant (unix seconds).
//
// Deliberately NOT from GPSDateStamp/GPSTimeStamp, which are in UTC and look like
// the easy answer: they record when the GPS FIX was acquired, not when the shutter
// fired. The Nikon sample this was built against has a fix from the previous day -
// using it would have dated the photo ~22 hours wrong.
//
// So: DateTimeOriginal is the truth, and the only question is its offset.
// OffsetTimeOriginal when the camera wrote one; otherwise `zoneOffsetMinutes`,
// which the caller derives from the photo's own coordinates.
export function exifTimestamp(taken, offsetMinutes, zoneOffsetMinutes) {
	if (!taken) return null;
	const utc = Date.UTC(taken.y, taken.mo - 1, taken.d, taken.h, taken.mi, taken.s);
	if (!Number.isFinite(utc)) return null;
	const off = Number.isFinite(offsetMinutes)
		? offsetMinutes
		: Number.isFinite(zoneOffsetMinutes)
			? zoneOffsetMinutes
			: 0;
	return Math.floor(utc / 1000) - off * 60;
}
