// english base dictionary - the fallback every other locale falls back to, and
// the source of truth for available keys. mirrors bitchat's Base.lproj: intent-
// named keys, with pluralized entries written as { one, other, ... } objects
// (resolved per-locale via Intl.PluralRules). interpolate {placeholders} with t().
//
// to add a language: copy this file to <code>.js (e.g. es.js), translate the
// values (keep the keys and {placeholders}), and register it in index.js.
export default {
	name_gate: {
		title: "enter a name",
		subtitle_1: "no accounts. no emails. no servers.",
		subtitle_2: "just pick a name to start chatting.",
		input_placeholder: "alias",
		enter: "enter",
		settings: "[ settings ]",
	},

	settings: {
		title: "settings",
		cat_api: "api",
		cat_client: "client",
		cat_visual: "visual",
		cat_filter: "filter",
		cat_nostr: "nostr",
		assist_description:
			"server assist pulls deep history and lowers bandwidth via an optional API. your client still works fully on its own if it's off or unavailable.",
		client_description:
			"stamps a 'client' tag reading glub.chat onto your signed events, so other nostr apps can show where you posted from. off omits the tag entirely.",
		local_description:
			"drops the teleport tag so your events read as local rather than teleported in. off keeps teleport — the honest state of a location-free web client.",
		retro_description:
			"a heavier CRT terminal look: scanlines, phosphor glow, flicker. purely cosmetic — nothing about the protocol or your messages changes.",
		pow_description:
			"hides inbound messages below a proof-of-work difficulty. raises the cost of spam, at the price of dropping low-effort or non-mining clients.",
		blur_description:
			"blurs inbound images until you tap to reveal them. off loads every image automatically. on by default; purely local.",
		censor_description:
			"hides messages containing listed profanity behind a nameless '* censored message *' you can tap to reveal. off by default; purely local.",
		profiles_description:
			"shows nostr display names and avatars for people who have a profile (needs server assist). off keeps everyone as their raw key handle.",
		identity_description:
			"your nostr secret key (nsec) is your whole identity, and never leaves this device. reveal it to back up, or paste one to import an identity.",
		assist_label: "server assist",
		profiles_label: "nostr profiles",
		retro_label: "retro terminal",
		client_label: "client tag",
		local_label: "local tag",
		blur_label: "media blur",
		censor_label: "text censor",
		pow_label: "proof of work",
		pow_off: "off",
		pow_lenient: "8 · lenient",
		pow_standard: "12 · standard",
		pow_strict: "16 · strict",
		pow_extreme: "20 · extreme",
		identity_label: "nostr identity",
		profile_edit_label: "nostr profile",
		profile_edit_description:
			"your public nostr profile (kind-0), shared across every nostr app. distinct from your glub chat name. images upload to nostr.build; a save republishes the whole profile.",
		profile_avatar: "+ avatar",
		profile_banner: "+ banner",
		profile_name_ph: "display name",
		profile_about_ph: "bio",
		profile_zap_ph: "zap address (lud16)",
		profile_nip05_ph: "nip-05 (name@domain)",
		profile_website_ph: "website",
		profile_save: "save profile",
		profile_loading: "loading profile…",
		profile_saving: "publishing…",
		profile_saved: "saved to {count} relays",
		profile_save_failed: "publish failed — try again",
		reveal_nsec: "reveal",
		hide_nsec: "hide",
		copy_nsec: "copy",
		paste_nsec: "paste",
		done: "done",
		toggle_on: "[ on ]",
		toggle_off: "[ off ]",
	},

	profile: {
		close: "close",
		loading: "loading profile…",
		none: "no nostr profile",
		npub_copied: "copied npub",
		npub_copy_failed: "copy failed",
	},

	actions: {
		title: "@{name}",
		dm: "direct message",
		mention: "mention",
		copy_npub: "copy npub",
		reply: "reply",
		block: "block",
		copy: "copy",
		translate: "translate",
		untranslate: "hide translation",
		hug: "hug",
		slap: "slap",
		cancel: "cancel",
		soon: "{action} — coming soon",
		self: "that's you",
		reply_banner: "replying to @{name}",
		pow_badge: "pow {n}",
		client_badge: "via {name}",
	},

	// the translated-message block + its status/error lines
	translate: {
		label: "translated",
		label_from: "translated from {lang}",
		working: "translating…",
		same: "already in your language",
		unavailable: "translation isn't available right now",
		failed: "couldn't translate that — try again",
	},

	// automated emote messages sent from the action popup. other-user emotes copy
	// bitchat's exact wording so native clients render them the same way; self-
	// emotes are our own (bitchat just reuses the generic template on yourself).
	emote: {
		hug: "* 🫂 {me} hugs {them} *",
		hug_self: "* 🫂 {me} hugs themselves. it counts *",
		slap: "* 🐟 {me} slaps {them} around a bit with a large trout *",
		slap_self: "* 🐟 {me} slaps themselves with a large trout. the trout is unimpressed *",
	},

	dm: {
		inbox_title: "messages",
		placeholder: "encrypted message…",
		empty: "no messages yet",
		with: "@{name}",
		no_conversations: "no conversations yet",
		received: "new message from @{name}",
		too_long: "message too long (max {max} chars)",
		send_failed: "no dm relay connected — try again",
		encrypted_note: "end-to-end encrypted · nip-17",
		unread: { one: "{count} unread", other: "{count} unread" },
		status_sent: "sent",
		status_delivered: "delivered",
		status_read: "read",
	},

	users: {
		title: "users in #{geo}",
		title_default: "users",
		exit: "[EXIT]",
		map: "[MAP]",
		notes: "[NOTES]",
		empty: "no one here yet",
		present: "present",
		international: "international",
		ghosts: { one: "ghost", other: "ghosts" },
	},

	origin: {
		local: "local",
		teleport: "teleport",
	},

	map: {
		title: "geohash map",
		hint: "drag to spin · zoom to explore · select a cell to join",
	},

	// the location-notes sheet: a persistent per-channel bulletin board (kind-1)
	notes: {
		title: "notes",
		placeholder: "leave a note for this channel…",
		post: "post",
		loading: "loading notes…",
		empty: "no notes here yet — leave the first",
		no_relays: "no relays for this channel",
		delete: "delete",
		fades_in: "fades in {time}",
		uploading: "uploading…",
		upload_failed: "upload failed — try again",
		too_large: "file too large (max {max}mb)",
		expiry_never: "expiry: never",
		expiry_1d: "expiry: 1 day",
		expiry_3d: "expiry: 3 days",
		expiry_7d: "expiry: 7 days",
	},

	topbar: {
		connecting: "CONNECTING...",
		relays: "RELAYS",
		users: { one: "{count} USER", other: "{count} USERS" },
		exit: "[EXIT]",
	},

	composer: {
		placeholder_global: "#channel to join…",
		placeholder_focused: "message -> #{geo}",
		placeholder_reply: "reply to @{name}…",
		send: "send",
		join: "join",
	},

	// the composer's channel-picker suggestions (global mode)
	suggest: {
		here: "{count} here",
	},

	message: {
		more: "more",
		less: "less",
		reveal: "[reveal]",
		beginning_of_chat: "beginning of chat",
		new_messages: { one: "[ {count} new message ]", other: "[ {count} new messages ]" },
	},

	ack: {
		sending: "sending…",
		resending: "resending…",
		unverified: "unverified",
		latency_lt1s: "<1s",
		latency_secs: "{count}s",
	},

	// payment chips: a detected lightning invoice / lnurl / cashu token renders as
	// a tap-to-copy chip instead of a raw blob
	payment: {
		lightning: "lightning invoice",
		lnurl: "lnurl",
		cashu: "ecash",
		copied: "copied",
		copy_failed: "copy failed",
	},

	time: {
		now: "now",
	},

	// one-line descriptions per command name; the source for both the "/" popup
	// and /help, so command copy lives in exactly one place.
	commands: {
		clear: "clear the view",
		join: "join any channel (spaces & case ok)",
		unclear: "restore cleared messages",
		echo: "echo a message via your bot",
		weather: "post weather (here or a place) via your bot",
		time: "post local time (here or a place) via your bot",
		roll: "roll dice via your bot (e.g. /roll 2d6)",
		"8ball": "ask the magic 8-ball via your bot",
		wordle: "play a private word game (/wordle <word>)",
		mute: "hide a channel from the global feed",
		unmute: "unhide a channel (blank = list muted)",
		unblock: "unblock a user (#tag, blank = list, all = clear)",
		rotate: "new keypair (optional hex vanity suffix)",
		theme: "switch color theme (blank = list themes)",
		help: "list commands",
	},

	system: {
		boot_1: "glub.chat // web client",
		boot_2: "keys minted + stored locally. nothing leaves this device",
		welcome: "welcome to the glub, {name}",
		cleared: "cleared",
		uncleared: "restored cleared messages",
		join_usage: "usage: /join <channel>",
		muted: "muted #{geo}",
		unmuted: "unmuted #{geo}",
		mute_usage: "usage: /mute #channel",
		mute_none: "no muted channels",
		muted_header: "muted channels",
		unmute_notmuted: "#{geo} isn't muted",
		blocked: "blocked @{name} (#{tag}) — /unblock {tag} to undo",
		block_none: "no blocked users",
		blocked_header: "blocked users",
		unblocked: "unblocked #{tag}",
		unblocked_all: "unblocked everyone",
		unblock_notblocked: "#{tag} isn't blocked",
		needs_channel: "join a channel first",
		not_a_location: "#{geo} is not a map location",
		weather_failed: "couldn't fetch weather right now",
		time_failed: "couldn't fetch time right now",
		place_notfound: "no place found for {q}",
		roll_usage: "usage: /roll [NdM] (e.g. /roll 2d6)",
		eightball_usage: "usage: /8ball <question>",
		wordle_badguess: "wordle · guesses are 5 letters",
		wordle_nolist: "wordle · word list unavailable",
		wordle_solved: "wordle · solved in {n}",
		wordle_over: "wordle · out of guesses",
		wordle_reveal: "the word was {word}",
		wordle_win: "nicely done",
		wordle_first_try: "first try · incredible",
		upload_too_large: "file too large (max {max}mb)",
		upload_failed: "upload failed",
		rotated: "new identity minted (#{tag})",
		rotate_badhex: "vanity suffix must be 1-4 hex chars (0-9, a-f)",
		rotate_searching: "searching for a #{suffix} identity... (may take a bit)",
		rotate_found: "found it - you're now #{tag}",
		rotate_giveup: "gave up searching for #{suffix}",
		rotate_busy: "already searching for a vanity key",
		nsec_blocked: "blocked - never paste your nsec into chat",
		nsec_copied: "copied",
		nsec_copy_failed: "copy failed",
		msg_copied: "copied message",
		copy_failed: "copy failed",
		nsec_paste_failed: "couldn't read clipboard",
		nsec_invalid: "invalid nsec",
		nsec_imported: "imported",
		unknown_command: "unknown command: /{name}",
		commands_header: "available commands",
		themes_header: "available themes",
		theme_current: "current",
		theme_set: "theme: {name}",
		theme_unknown: "unknown theme: {name} (try /theme to list)",
		censored: "* censored message *",
		panic: "panic cleared",
		assist_active: "server assist is active",
		relay_global_teleport: "#{geo}: not a location, connecting to global relay set...",
		relay_local: "#{geo}: connecting to local relay set...",
		relay_global: "connecting to global relay set...",
		relay_failed: "failed to load relays: {error}",
	},
};
