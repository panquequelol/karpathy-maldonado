import { proto } from "@whiskeysockets/baileys";
import { Data, Effect } from "effect";

const MessageType = {
	TEXT: "text",
	IMAGE: "image",
	VIDEO: "video",
	AUDIO: "audio",
	DOCUMENT: "document",
	STICKER: "sticker",
	LLOCATION: "location",
	CONTACT: "contact",
	UNKNOWN: "unknown",
} as const;

type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

type GroupJid = `${string}@g.us`;
type UserJid = `${string}@s.whatsapp.net`;
type Jid = GroupJid | UserJid;

interface WhatsAppMessage {
	readonly id: string;
	readonly fromJid: Jid;
	readonly fromMe: boolean;
	readonly author: UserJid | null;
	readonly type: MessageTypeValue;
	readonly content: string | null;
	readonly timestamp: number;
	readonly groupJid: GroupJid | null;
}

interface ConnectionUpdate {
	readonly connection: "close" | "open" | "connecting";
	readonly lastDisconnect?: Error;
}

interface ConnectionState {
	readonly status: "disconnected" | "connecting" | "connected" | "logged-out";
	readonly shouldReconnect: boolean;
}

class MessageParseError extends Data.TaggedError("MessageParseError")<{
	readonly reason: "MissingKey" | "MissingMessage" | "InvalidTimestamp";
}> {
	override readonly message = "Failed to parse WhatsApp message";
}

class InvalidTimestampError extends Data.TaggedError("InvalidTimestampError")<{
	readonly timestamp: unknown;
}> {
	override readonly message = "Invalid message timestamp value";
}

const extractContent = (message: proto.IMessage): string | null => {
	if (message.conversation) return message.conversation;
	if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
	if (message.imageMessage?.caption) return message.imageMessage.caption;
	if (message.videoMessage?.caption) return message.videoMessage.caption;
	return null;
};

const determineMessageType = (message: proto.IMessage): MessageTypeValue => {
	if (message.imageMessage) return MessageType.IMAGE;
	if (message.videoMessage) return MessageType.VIDEO;
	if (message.audioMessage) return MessageType.AUDIO;
	if (message.documentMessage) return MessageType.DOCUMENT;
	if (message.stickerMessage) return MessageType.STICKER;
	if (message.contactMessage) return MessageType.CONTACT;
	if (message.locationMessage) return MessageType.LLOCATION;
	if (message.conversation || message.extendedTextMessage) return MessageType.TEXT;
	return MessageType.UNKNOWN;
};

const extractTimestamp = (ts: proto.IWebMessageInfo["messageTimestamp"]): number => {
	if (ts === undefined || ts === null) return Date.now();

	const numTs = typeof ts === "number" ? ts : ts.toNumber();
	if (isNaN(numTs) || numTs === 0) return Date.now();

	return numTs;
};

const createMessageFromProto = (
	protoMessage: proto.IWebMessageInfo,
): Effect.Effect<WhatsAppMessage, MessageParseError> =>
	Effect.gen(function* () {
		const { key, message, messageTimestamp } = protoMessage;

		if (!key) {
			return yield* Effect.fail(new MessageParseError({ reason: "MissingKey" }));
		}
		if (!message) {
			return yield* Effect.fail(new MessageParseError({ reason: "MissingMessage" }));
		}

		const isGroup = key.remoteJid?.endsWith("@g.us") ?? false;

		return {
			id: key.id ?? "",
			fromJid: key.remoteJid as Jid,
			fromMe: key.fromMe ?? false,
			author: (key.participant ?? null) as UserJid | null,
			type: determineMessageType(message),
			content: extractContent(message),
			timestamp: extractTimestamp(messageTimestamp),
			groupJid: isGroup ? (key.remoteJid as GroupJid) : null,
		} as const;
	});

const isGroupMessage = (message: WhatsAppMessage): message is WhatsAppMessage & { readonly groupJid: GroupJid } =>
	message.groupJid !== null;

const formatMessageForLog = (message: WhatsAppMessage): string => {
	const isSeconds = message.timestamp < 10000000000;
	const timestamp = new Date(isSeconds ? message.timestamp * 1000 : message.timestamp).toISOString();
	const fromMe = message.fromMe ? "You" : message.author ?? "Unknown";
	const group = message.groupJid ?? "DM";
	const content = message.content ?? `[${message.type}]`;
	return `${timestamp} | ${group} | ${fromMe}: ${content}`;
};

export type { ConnectionUpdate, ConnectionState, GroupJid, Jid, MessageTypeValue, WhatsAppMessage };
export {
	MessageParseError,
	InvalidTimestampError,
	MessageType,
	createMessageFromProto,
	determineMessageType,
	extractContent,
	extractTimestamp,
	formatMessageForLog,
	isGroupMessage,
};
