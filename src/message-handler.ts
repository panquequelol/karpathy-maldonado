import { proto } from "@whiskeysockets/baileys";
import { Effect } from "effect";
import {
	createMessageFromProto,
	formatMessageForLog,
	isGroupMessage,
	type WhatsAppMessage,
} from "./types";
import type { Config } from "./config";

const logMessageToConsole = (message: WhatsAppMessage): Effect.Effect<void> =>
	Effect.log(formatMessageForLog(message)).pipe(
		Effect.annotateLogs("source", "whatsapp"),
		Effect.annotateLogs("group", message.groupJid ?? "dm"),
	);

const createIsGroupAllowedFilter = (config: Config) => {
	const allowedJids = new Set(config.allowedGroupJids);

	return (message: WhatsAppMessage): boolean => {
		if (!isGroupMessage(message)) return false;
		return allowedJids.has(message.groupJid);
	};
};

const handleIncomingMessage = (
	protoMessage: proto.IWebMessageInfo,
	isGroupAllowed: (message: WhatsAppMessage) => boolean,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const message = yield* createMessageFromProto(protoMessage);

		if (isGroupAllowed(message)) {
			yield* logMessageToConsole(message);
		}
	}).pipe(
		// Log parse errors but don't fail the fiber
		Effect.catchAll((error) => Effect.logError(`Failed to handle message: ${error}`)),
	);

const createMessageHandler = (config: Config) => {
	const isGroupAllowed = createIsGroupAllowedFilter(config);

	// Run in background fiber - this is the edge of our Effect program
	// where we integrate with Baileys' non-Effect callback system
	return (protoMessage: proto.IWebMessageInfo): void => {
		Effect.runFork(handleIncomingMessage(protoMessage, isGroupAllowed));
	};
};

export {
	createMessageHandler,
	createIsGroupAllowedFilter,
	handleIncomingMessage,
	logMessageToConsole,
};
