// russian dictionary. keys mirror en.js (the source of truth); anything missing
// here falls back to english automatically.
//
// deliberately omitted: the `emote` section. emotes are broadcast into the
// channel as message content (canonical bitchat wording), so they stay english
// for every sender regardless of ui language.
//
// pluralized entries carry the russian categories (one/few/many) resolved via
// Intl.PluralRules("ru").
export default {
	name_gate: {
		title: "введите имя",
		subtitle_1: "без аккаунтов. без почты. без серверов.",
		subtitle_2: "просто выберите имя и начните общаться.",
		input_placeholder: "псевдоним",
		enter: "войти",
		settings: "[ настройки ]",
	},

	settings: {
		title: "настройки",
		cat_api: "api",
		cat_client: "клиент",
		cat_visual: "вид",
		cat_filter: "фильтр",
		cat_nostr: "nostr",
		assist_description:
			"серверный ассист подтягивает глубокую историю и снижает трафик через опциональный API. без него клиент полностью работает сам по себе.",
		client_description:
			"добавляет тег «client» со значением glub.chat в ваши подписанные события, чтобы другие nostr-клиенты видели, откуда вы писали. выкл — тег не добавляется.",
		local_description:
			"убирает тег teleport, чтобы события читались как локальные, а не телепортированные. выкл сохраняет teleport — честное состояние веб-клиента без геолокации.",
		retro_description:
			"более выраженный вид ЭЛТ-терминала: строки развёртки, свечение люминофора, мерцание. чисто косметика — протокол и сообщения не меняются.",
		pow_description:
			"скрывает входящие сообщения ниже заданной сложности proof-of-work. повышает цену спама ценой отсева простых и немайнящих клиентов.",
		profiles_description:
			"показывает отображаемые имена и аватары nostr для тех, у кого есть профиль (нужен серверный ассист). выкл — все остаются под сырым ключом.",
		identity_description:
			"секретный ключ nostr (nsec) — это вся ваша личность, и он не покидает это устройство. покажите его для резервной копии или вставьте, чтобы импортировать.",
		assist_label: "серверный ассист",
		profiles_label: "профили nostr",
		retro_label: "ретро-терминал",
		client_label: "тег клиента",
		local_label: "локальный тег",
		pow_label: "proof of work",
		pow_off: "выкл",
		pow_lenient: "8 · мягкий",
		pow_standard: "12 · стандарт",
		pow_strict: "16 · строгий",
		pow_extreme: "20 · экстрим",
		identity_label: "идентичность nostr",
		reveal_nsec: "показать",
		hide_nsec: "скрыть",
		copy_nsec: "копировать",
		paste_nsec: "вставить",
		done: "готово",
		toggle_on: "[ вкл ]",
		toggle_off: "[ выкл ]",
	},

	profile: {
		close: "закрыть",
		loading: "загрузка профиля…",
		none: "нет профиля nostr",
		npub_copied: "npub скопирован",
		npub_copy_failed: "ошибка копирования",
	},

	actions: {
		title: "@{name}",
		dm: "личное сообщение",
		mention: "упомянуть",
		copy_npub: "копировать npub",
		reply: "ответить",
		block: "заблокировать",
		copy: "копировать сообщение",
		translate: "перевести сообщение",
		untranslate: "скрыть перевод",
		hug: "обнять",
		slap: "шлёпнуть",
		cancel: "отмена",
		soon: "{action} — скоро",
		self: "это вы",
		reply_banner: "отвечаете @{name}",
		pow_badge: "pow {n}",
		client_badge: "через {name}",
	},

	translate: {
		label: "перевод",
		label_from: "перевод с {lang}",
		working: "перевожу…",
		same: "уже на вашем языке",
		unavailable: "перевод сейчас недоступен",
		failed: "не удалось перевести — попробуйте ещё раз",
	},

	dm: {
		inbox_title: "сообщения",
		placeholder: "зашифрованное сообщение…",
		empty: "пока нет сообщений",
		with: "@{name}",
		no_conversations: "пока нет переписок",
		received: "новое сообщение от @{name}",
		too_long: "слишком длинное сообщение (макс. {max} символов)",
		send_failed: "нет соединения с dm-релеем — попробуйте ещё раз",
		encrypted_note: "сквозное шифрование · nip-17",
		unread: {
			one: "{count} непрочитанное",
			few: "{count} непрочитанных",
			many: "{count} непрочитанных",
			other: "{count} непрочитанных",
		},
		status_sent: "отправлено",
		status_delivered: "доставлено",
		status_read: "прочитано",
	},

	users: {
		title: "кто в #{geo}",
		title_default: "участники",
		exit: "[ВЫХОД]",
		map: "[КАРТА]",
		notes: "[ЗАМЕТКИ]",
		empty: "здесь пока никого",
		present: "здесь",
		international: "нейтральные воды",
		ghosts: { one: "призрак", few: "призрака", many: "призраков", other: "призраков" },
	},

	origin: {
		local: "местный",
		teleport: "телепорт",
	},

	map: {
		title: "карта геохешей",
		hint: "тяните — вращать · зум — обзор · выберите ячейку — войти",
	},

	notes: {
		title: "заметки",
		placeholder: "оставьте заметку в этом канале…",
		post: "оставить",
		loading: "загрузка заметок…",
		empty: "заметок пока нет — оставьте первую",
		no_relays: "нет релеев для этого канала",
		delete: "удалить",
		fades_in: "исчезнет через {time}",
		uploading: "загрузка…",
		upload_failed: "не удалось загрузить — попробуйте ещё раз",
		too_large: "файл слишком большой (макс. {max}мб)",
		expiry_never: "срок: никогда",
		expiry_1d: "срок: 1 день",
		expiry_3d: "срок: 3 дня",
		expiry_7d: "срок: 7 дней",
	},

	topbar: {
		connecting: "ПОДКЛЮЧЕНИЕ...",
		relays: "РЕЛЕИ",
		users: {
			one: "{count} ЮЗЕР",
			few: "{count} ЮЗЕРА",
			many: "{count} ЮЗЕРОВ",
			other: "{count} ЮЗЕРОВ",
		},
		exit: "[ВЫХОД]",
	},

	composer: {
		placeholder_global: "#канал сообщение...",
		placeholder_focused: "сообщение -> #{geo}",
		placeholder_reply: "ответ @{name}…",
		send: "отправить",
		join: "войти",
	},

	message: {
		more: "ещё",
		less: "свернуть",
		reveal: "[показать]",
		beginning_of_chat: "начало чата",
		new_messages: {
			one: "[ {count} новое сообщение ]",
			few: "[ {count} новых сообщения ]",
			many: "[ {count} новых сообщений ]",
			other: "[ {count} новых сообщений ]",
		},
	},

	ack: {
		sending: "отправка…",
		resending: "переотправка…",
		failed: "[!] ошибка",
		latency_lt1s: "<1с",
		latency_secs: "{count}с",
	},

	time: {
		now: "сейчас",
	},

	commands: {
		clear: "очистить экран",
		join: "войти в любой канал (пробелы и регистр ок)",
		unclear: "вернуть скрытые сообщения",
		censor: "цензура медиа или текста (/censor <media|text> <on|off>)",
		echo: "эхо через вашего бота",
		mute: "скрыть канал из общей ленты",
		unmute: "вернуть канал (пусто = список скрытых)",
		unblock: "разблокировать (#tag, пусто = список, all = всех)",
		rotate: "новая пара ключей (опц. hex-суффикс)",
		theme: "сменить тему (пусто = список тем)",
		help: "список команд",
	},

	system: {
		boot_1: "glub.chat // веб-клиент",
		boot_2: "ключи созданы и хранятся локально. ничего не покидает это устройство",
		welcome: "добро пожаловать в glub, {name}",
		cleared: "очищено",
		uncleared: "скрытые сообщения восстановлены",
		join_usage: "использование: /join <канал>",
		muted: "#{geo} скрыт",
		unmuted: "#{geo} возвращён",
		mute_usage: "использование: /mute #канал",
		mute_none: "нет скрытых каналов",
		muted_header: "скрытые каналы",
		unmute_notmuted: "#{geo} не скрыт",
		blocked: "@{name} (#{tag}) заблокирован — /unblock {tag}, чтобы вернуть",
		block_none: "нет заблокированных",
		blocked_header: "заблокированные",
		unblocked: "#{tag} разблокирован",
		unblocked_all: "все разблокированы",
		unblock_notblocked: "#{tag} не заблокирован",
		needs_channel: "сначала войдите в канал",
		upload_too_large: "файл слишком большой (макс. {max}мб)",
		upload_failed: "не удалось загрузить",
		rotated: "новая идентичность создана (#{tag})",
		rotate_badhex: "суффикс: 1-4 hex-символа (0-9, a-f)",
		rotate_searching: "ищу идентичность #{suffix}... (может занять время)",
		rotate_found: "нашёл - теперь вы #{tag}",
		rotate_giveup: "не нашёл #{suffix}, сдаюсь",
		rotate_busy: "поиск ключа уже идёт",
		nsec_blocked: "заблокировано - никогда не вставляйте свой nsec в чат",
		nsec_copied: "скопировано",
		nsec_copy_failed: "ошибка копирования",
		msg_copied: "сообщение скопировано",
		copy_failed: "ошибка копирования",
		nsec_paste_failed: "не удалось прочитать буфер обмена",
		nsec_invalid: "неверный nsec",
		nsec_imported: "импортировано",
		unknown_command: "неизвестная команда: /{name}",
		commands_header: "доступные команды",
		themes_header: "доступные темы",
		theme_current: "текущая",
		theme_set: "тема: {name}",
		theme_unknown: "неизвестная тема: {name} (список: /theme)",
		censored: "* сообщение скрыто *",
		censor_usage: "использование: /censor <media|text> <on|off>",
		censor_media_on: "размытие медиа включено",
		censor_media_off: "размытие медиа выключено",
		censor_text_on: "цензура текста включена",
		censor_text_off: "цензура текста выключена",
		panic: "паника: очищено",
		assist_active: "серверный ассист активен",
		relay_global_teleport: "#{geo}: не место на карте, подключаюсь к глобальным релеям...",
		relay_local: "#{geo}: подключаюсь к местным релеям...",
		relay_global: "подключаюсь к глобальным релеям...",
		relay_failed: "не удалось загрузить релеи: {error}",
	},
};
