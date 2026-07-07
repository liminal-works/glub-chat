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
	},

	settings: {
		title: "settings",
		assist_description:
			"server assist pulls deep history and lowers bandwidth via an optional API. your client still works fully on its own if it's off or unavailable.",
		assist_label: "server assist",
		profiles_label: "nostr profiles",
		identity_label: "nostr identity",
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
		reply: "reply",
		block: "block",
		copy: "copy message",
		translate: "translate message",
		hug: "hug",
		slap: "slap",
		cancel: "cancel",
		soon: "{action} — coming soon",
		self: "that's you",
		reply_banner: "replying to @{name}",
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
		empty: "no one here yet",
		present: "present",
		ghosts: { one: "ghost", other: "ghosts" },
	},

	origin: {
		local: "local",
		teleport: "teleport",
	},

	topbar: {
		connecting: "CONNECTING...",
		relays: "RELAYS",
		users: { one: "{count} USER", other: "{count} USERS" },
		exit: "[EXIT]",
	},

	composer: {
		placeholder_global: "#channel message...",
		placeholder_focused: "message -> #{geo}",
		placeholder_reply: "reply to @{name}…",
		send: "send",
	},

	message: {
		more: "more",
		less: "less",
		reveal: "[reveal]",
		beginning_of_chat: "beginning of chat",
		new_messages: { one: "[ {count} new message ]", other: "[ {count} new messages ]" },
	},

	ack: {
		resending: "resending…",
		failed: "[!] failed",
		latency_lt1s: "<1s",
		latency_secs: "{count}s",
	},

	time: {
		now: "now",
	},

	// one-line descriptions per command name; the source for both the "/" popup
	// and /help, so command copy lives in exactly one place.
	commands: {
		clear: "clear the view",
		dms: "open direct messages",
		join: "join any channel (spaces & case ok)",
		unclear: "restore cleared messages",
		echo: "echo a message via your bot",
		mute: "hide a channel from the global feed",
		unmute: "unhide a channel (blank = list muted)",
		rotate: "new keypair (optional hex vanity suffix)",
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
		needs_channel: "join a channel first",
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
		assist_active: "server assist is active",
		relay_global_teleport: "#{geo}: not a location, connecting to global relay set...",
		relay_local: "#{geo}: connecting to local relay set...",
		relay_global: "connecting to global relay set...",
		relay_failed: "failed to load relays: {error}",
	},
};
