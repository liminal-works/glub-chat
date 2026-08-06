// Storage for cashu proofs, which are BEARER tokens: this file IS the money. Two
// consequences shape the whole module.
//
// Writes are atomic. A torn write here is not a corrupt cache that refills itself,
// it is every sat gone - and `fs.writeFileSync` straight over the live file gives
// you exactly that if the process dies mid-write. So: write a temp file, fsync it,
// then rename over the target. Rename is atomic on POSIX, so a reader either sees
// the whole old file or the whole new one.
//
// And every write keeps the previous versions. "The file is briefly wrong" and "the
// file is empty" are indistinguishable to JSON.parse, and only one of them is
// recoverable - so the loader walks backwards through the backups rather than
// starting from zero, because starting from zero silently means "we have no money"
// and that is the one answer that must never be a default.

import fs from "node:fs";
import path from "node:path";

export function openProofStore(filePath, { backups = 5 } = {}) {
	const file = path.resolve(filePath);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });

	const backupPath = (n) => `${file}.${n}`;

	function readOne(p) {
		const raw = fs.readFileSync(p, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error("not an array");
		return parsed;
	}

	// The live file first, then each backup, newest first. A corrupt live file is a
	// crash mid-write; the newest intact backup is the last known-good balance.
	function load() {
		const candidates = [file, ...Array.from({ length: backups }, (_, i) => backupPath(i + 1))];
		for (const [i, p] of candidates.entries()) {
			if (!fs.existsSync(p)) continue;
			try {
				const proofs = readOne(p);
				if (i > 0) {
					console.error(
						`[proofs] ${file} was unreadable; recovered ${proofs.length} proofs from ${p}. ` +
							`Check the mint for anything minted after that snapshot.`,
					);
				}
				return proofs;
			} catch (e) {
				console.error(`[proofs] ${p} unreadable (${e.message}), trying older snapshot`);
			}
		}
		return [];
	}

	let proofs = load();
	if (proofs.length) console.log(`[proofs] loaded ${proofs.length} proofs (${total()} sats)`);

	function total() {
		return proofs.reduce((n, p) => n + (Number(p?.amount) || 0), 0);
	}

	function rotate() {
		if (!fs.existsSync(file)) return;
		// oldest first, so nothing is overwritten before it has been shifted along
		for (let i = backups - 1; i >= 1; i--) {
			if (fs.existsSync(backupPath(i))) {
				try {
					fs.renameSync(backupPath(i), backupPath(i + 1));
				} catch (e) {
					console.error(`[proofs] backup rotate failed: ${e.message}`);
				}
			}
		}
		// COPY rather than rename: the live file must stay in place until the new one
		// is renamed over it, so a crash in here can never leave us with no file at all
		try {
			fs.copyFileSync(file, backupPath(1));
		} catch (e) {
			console.error(`[proofs] backup copy failed: ${e.message}`);
		}
	}

	function persist(next) {
		const tmp = `${file}.tmp`;
		const json = JSON.stringify(next, null, 2);
		const fd = fs.openSync(tmp, "w");
		try {
			fs.writeFileSync(fd, json);
			fs.fsyncSync(fd); // on disk, not just in the page cache
		} finally {
			fs.closeSync(fd);
		}
		rotate();
		fs.renameSync(tmp, file);
		proofs = next;
	}

	return {
		all: () => proofs.slice(),
		count: () => proofs.length,
		total,
		// wholesale replacement - what a melt does, where the surviving set is
		// (unspent change + kept proofs) and anything not in it has been spent
		replace(next) {
			persist(Array.isArray(next) ? next : []);
			return total();
		},
		add(incoming) {
			if (!incoming?.length) return total();
			persist([...proofs, ...incoming]);
			return total();
		},
		path: file,
	};
}
