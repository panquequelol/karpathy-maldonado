import { proto, type WASocket } from "@whiskeysockets/baileys";
import { Effect, Layer, Ref } from "effect";
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

const isGroupAllowed = (config: Config, message: WhatsAppMessage): boolean => {
	if (config.mode === "discovery") {
		return false;
	}
	if (!isGroupMessage(message)) {
		return false;
	}
	return config.allowedGroupJids.includes(message.groupJid);
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
	configRef: Ref.Ref<Config>,
): Effect.Effect<void, never, OpenRouterConfig> =>
	Effect.gen(function* () {
		const config = yield* Ref.get(configRef);
		const message = yield* createMessageFromProto(protoMessage);

		if (isGroupAllowed(config, message)) {
			yield* logMessageToConsole(message);
			yield* processMessageForEvent(message);
		}
	}).pipe(
		// Log parse errors but don't fail the fiber
		Effect.catchAll((error) => Effect.logError(`Failed to handle message: ${error}`)),
	);

const createMessageHandler = (
	configRef: Ref.Ref<Config>,
	appLayer: Layer.Layer<OpenRouterConfig>,
) => {
	// Run in background fiber - this is the edge of our Effect program
	// where we integrate with Baileys' non-Effect callback system
	return (socket: WASocket, protoMessage: proto.IWebMessageInfo): void => {
		Effect.runFork(handleIncomingMessage(protoMessage, socket, configRef).pipe(Effect.provide(appLayer)));
	};
};

export {
	createMessageHandler,
	isGroupAllowed,
	handleIncomingMessage,
	logMessageToConsole,
};
