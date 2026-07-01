// generic autocomplete/suggestion popup. purely presentational + input handling:
// it knows nothing about mentions or commands. the caller detects a trigger,
// hands it a list of items and an onPick callback, and this renders them, tracks
// the active row, and handles keyboard + pointer selection.
//
// each item: {
//   html:   trusted markup for the row's main label (caller escapes it)
//   insert: string committed to the input when picked
//   accent: (optional) a color the active-row highlight samples, so a row can
//           glow in its own color (e.g. a user's assigned color) instead of one
//           fixed hue; falls back to the css default when absent
//   meta:   (optional) trusted markup for a dim secondary label (e.g. a command
//           description); unused by mentions
// }
//
// the box is styled (css) to sit above the composer and grow upward, so items[0]
// - the best/nearest match - lands at the bottom, closest to the keyboard.
// designed to be reused: mentions today, local "/command" hints later.
export function createSuggest(boxEl) {
	let items = [];
	let active = 0; // index into items; 0 == bottom-most (nearest the input)
	let onPick = null;

	function render() {
		boxEl.innerHTML = items
			.map((it, i) => {
				const cls = `suggestRow${i === active ? " active" : ""}`;
				// per-row highlight tint: the active row samples this color (css
				// color-mix), so a row glows in its own color rather than one fixed hue.
				const accent = it.accent ? ` style="--row-accent:${it.accent}"` : "";
				const meta = it.meta ? `<span class="suggestMeta">${it.meta}</span>` : "";
				return `<div class="${cls}"${accent} data-idx="${i}">${it.html}${meta}</div>`;
			})
			.join("");
		const activeEl = boxEl.querySelector(".suggestRow.active");
		if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
	}

	function show(nextItems, pick) {
		items = nextItems;
		onPick = pick;
		active = 0;
		boxEl.hidden = false;
		render();
	}

	function hide() {
		if (boxEl.hidden) return;
		boxEl.hidden = true;
		boxEl.innerHTML = "";
		items = [];
		onPick = null;
	}

	function isOpen() {
		return !boxEl.hidden;
	}

	function move(delta) {
		if (!items.length) return;
		active = Math.max(0, Math.min(items.length - 1, active + delta));
		render();
	}

	function pick(i) {
		const it = items[i];
		const cb = onPick;
		hide();
		if (it && cb) cb(it);
	}

	// returns true if the key was consumed (so the caller doesn't also act on it,
	// e.g. Enter shouldn't send the message while a suggestion is open). Up/Down are
	// inverted vs. index because the list is rendered bottom-up.
	function handleKey(e) {
		if (!isOpen()) return false;
		switch (e.key) {
			case "ArrowUp":
				e.preventDefault();
				move(1);
				return true;
			case "ArrowDown":
				e.preventDefault();
				move(-1);
				return true;
			case "Enter":
			case "Tab":
				e.preventDefault();
				pick(active);
				return true;
			case "Escape":
				e.preventDefault();
				hide();
				return true;
			default:
				return false;
		}
	}

	// pointerdown (not click) so we fire before the input blurs; preventDefault
	// keeps focus in the input so the caret/selection survives the pick.
	boxEl.addEventListener("pointerdown", (e) => {
		const row = e.target.closest(".suggestRow");
		if (!row) return;
		e.preventDefault();
		pick(Number(row.dataset.idx));
	});

	return { show, hide, isOpen, handleKey };
}
