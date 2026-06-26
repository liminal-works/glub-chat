import { finalizeEvent } from "https://esm.sh/nostr-tools@2";

// bitchat's geohash channels ride on these two ephemeral nostr kinds:
// 20000 = chat message, 20001 = presence/announce.
export const CHAT_KIND = 20000;
export const PRESENCE_KIND = 20001;

export function subscribeFilter(sinceSec) {
	return { kinds: [CHAT_KIND, PRESENCE_KIND], since: sinceSec };
}

export function makeChatMessage({ content, geohash, name, sk, pk }) {
	const tags = [["g", geohash]];
	if (name) tags.push(["n", name]);

	return finalizeEvent(
		{
			kind: CHAT_KIND,
			created_at: Math.floor(Date.now() / 1000),
			tags,
			content,
			pubkey: pk,
		},
		sk
	);
}

export function getTag(ev, key) {
	const tags = Array.isArray(ev.tags) ? ev.tags : [];
	return tags.find((t) => Array.isArray(t) && t[0] === key)?.[1] || "";
}

export function getGeohash(ev) {
	return getTag(ev, "g");
}

export function getName(ev) {
	return getTag(ev, "n");
}
