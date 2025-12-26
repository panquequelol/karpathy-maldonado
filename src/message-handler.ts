import { proto, type WASocket } from "@whiskeysockets/baileys";
import { Effect, Layer } from "effect";
import {
	createMessageFromProto,
	formatMessageForLog,
	isGroupMessage,
	type WhatsAppMessage,
} from "./types";
import type { Config } from "./config";
import { classifyMessage, extractEvent, OpenRouterConfig } from "./openrouter";

const logMessageToConsole = (message: WhatsAppMessage): Effect.Effect<void> =>
	Effect.log(formatMessageForLog(message));

const logEventToConsole = (event: unknown): Effect.Effect<void> =>
	Effect.log(`[EVENT EXTRACTED] ${JSON.stringify(event, null, 2)}`);

const createIsGroupAllowedFilter = (config: Config) => {
	if (config.mode === "discovery") {
		return (_message: WhatsAppMessage): boolean => false;
	}

	const allowedJids = new Set(config.allowedGroupJids);

	return (message: WhatsAppMessage): boolean => {
		if (!isGroupMessage(message)) return false;
		return allowedJids.has(message.groupJid);
	};
};

const processMessageForEvent = (message: WhatsAppMessage): Effect.Effect<void, never, OpenRouterConfig> =>
	Effect.gen(function* () {
		if (!message.content) {
			yield* Effect.logDebug("No content in message, skipping event processing");
			return;
		}

		yield* Effect.logInfo("Starting event classification...");

		const isEventResult = yield* Effect.either(classifyMessage(message.content));

		if (isEventResult._tag === "Left") {
			yield* Effect.logError(`Classification failed: ${isEventResult.left.reason}`);
			return;
		}

		if (!isEventResult.right) {
			yield* Effect.logDebug(`Message not classified as event, skipping extraction`);
			return;
		}

		yield* Effect.logInfo("Message classified as event, extracting data...");

		const eventResult = yield* Effect.either(extractEvent(message.content));

		if (eventResult._tag === "Left") {
			yield* Effect.logError(`Extraction failed: ${eventResult.left.reason}`);
			return;
		}

		yield* logEventToConsole(eventResult.right);
	});

const handleIncomingMessage = (
	protoMessage: proto.IWebMessageInfo,
	_socket: WASocket,
	isGroupAllowed: (message: WhatsAppMessage) => boolean,
): Effect.Effect<void, never, OpenRouterConfig> =>
	Effect.gen(function* () {
		const message = yield* createMessageFromProto(protoMessage);

		if (isGroupAllowed(message)) {
			yield* logMessageToConsole(message);
			yield* processMessageForEvent(message);
		}
	}).pipe(
		// Log parse errors but don't fail the fiber
		Effect.catchAll((error) => Effect.logError(`Failed to handle message: ${error}`)),
	);

const createMessageHandler = (config: Config, appLayer: Layer.Layer<OpenRouterConfig>) => {
	const isGroupAllowed = createIsGroupAllowedFilter(config);

	// Run in background fiber - this is the edge of our Effect program
	// where we integrate with Baileys' non-Effect callback system
	return (socket: WASocket, protoMessage: proto.IWebMessageInfo): void => {
		Effect.runFork(handleIncomingMessage(protoMessage, socket, isGroupAllowed).pipe(Effect.provide(appLayer)));
	};
};

export {
	createMessageHandler,
	createIsGroupAllowedFilter,
	handleIncomingMessage,
	logMessageToConsole,
};
