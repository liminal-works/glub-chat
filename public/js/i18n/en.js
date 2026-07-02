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
		identity_label: "identity",
		identity_note: "your nsec is your account — back it up, never share it.",
		copy_nsec: "copy your nsec",
		nsec_placeholder: "paste an nsec",
		import_nsec: "import",
		done: "done",
		toggle_on: "[ on ]",
		toggle_off: "[ off ]",
	},

	profile: {
		close: "close",
		loading: "loading profile…",
		none: "no nostr profile",
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
		unclear: "restore cleared messages",
		echo: "echo a message via your bot",
		rotate: "new keypair (optional hex vanity suffix)",
		help: "list commands",
	},

	system: {
		welcome: "welcome to the glub, {name}",
		cleared: "cleared",
		uncleared: "restored cleared messages",
		needs_channel: "join a channel first",
		upload_too_large: "file too large (max {max}mb)",
		upload_failed: "upload failed",
		rotated: "new identity minted (#{tag})",
		rotate_badhex: "vanity suffix must be 1-4 hex chars (0-9, a-f)",
		rotate_searching: "searching for a #{suffix} identity... (may take a bit)",
		rotate_found: "found it - you're now #{tag}",
		rotate_giveup: "gave up searching for #{suffix}",
		rotate_busy: "already searching for a vanity key",
		imported: "imported your nostr identity (#{tag})",
		nsec_blocked: "blocked - never paste your nsec into chat",
		nsec_copied: "copied to clipboard",
		nsec_copy_failed: "couldn't copy",
		nsec_invalid: "invalid nsec",
		unknown_command: "unknown command: /{name}",
		commands_header: "available commands",
		assist_active: "server assist is active",
		relay_global_teleport: "#{geo}: not a location, connecting to global relay set...",
		relay_local: "#{geo}: connecting to local relay set...",
		relay_global: "connecting to global relay set...",
		relay_failed: "failed to load relays: {error}",
	},
};
