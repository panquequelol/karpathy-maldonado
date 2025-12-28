import { proto, type WASocket } from "@whiskeysockets/baileys";
import { Effect, Layer, Ref } from "effect";
import {
	createMessageFromProto,
	formatMessageForLog,
	isGroupMessage,
	type WhatsAppMessage,
	type GroupJid,
	type UserJid,
} from "./types";
import type { Config } from "./config";
import { classifyMessage, extractEvent, OpenRouterConfig } from "./openrouter";
import { EventStorage } from "./db/event-storage";

const logMessageToConsole = (message: WhatsAppMessage): Effect.Effect<void> =>
	Effect.log(formatMessageForLog(message));

const processMessageForEvent = (message: WhatsAppMessage) =>
	Effect.gen(function* () {
		if (!message.content) {
			return;
		}

		const isEventResult = yield* Effect.either(classifyMessage(message.content));

		if (isEventResult._tag === "Left") {
			yield* Effect.logError(`Clasificación fallida: ${isEventResult.left.reason}`);
			return;
		}

		if (!isEventResult.right) {
			return;
		}

		const eventResult = yield* Effect.either(extractEvent(message.content));

		if (eventResult._tag === "Left") {
			yield* Effect.logError(`Extracción fallida: ${eventResult.left.reason}`);
			return;
		}

		const event = eventResult.right;
		const eventStorage = yield* EventStorage;

		if (!message.groupJid || !message.author) {
			yield* Effect.logError("No se puede guardar el evento: falta group JID o autor");
			return;
		}

		const saveResult = yield* Effect.either(
			eventStorage.saveEvent({
				event,
				messageBody: message.content,
				whatsappMessageId: message.id,
				whatsappGroupJid: message.groupJid as GroupJid,
				whatsappSenderJid: message.author as UserJid,
			}),
		);

		if (saveResult._tag === "Left") {
			const error = saveResult.left;
			if (error._tag === "DuplicateEventError") {
				yield* Effect.logDebug(`Evento duplicado: ${event.title}`);
				return;
			}
			yield* Effect.logError(`Falló al guardar el evento: ${error.reason}`);
			return;
		}

		yield* Effect.logInfo(`Evento guardado: "${event.title}"`);
	});

const handleIncomingMessage = (
	protoMessage: proto.IWebMessageInfo,
	_socket: WASocket,
	configRef: Ref.Ref<Config>,
) =>
	Effect.gen(function* () {
		const config = yield* Ref.get(configRef);
		const message = yield* createMessageFromProto(protoMessage);

		if (config.mode === "discovery" || !isGroupMessage(message)) {
			return;
		}

		if (!config.allowedGroupJids.includes(message.groupJid)) {
			return;
		}

		yield* logMessageToConsole(message);
		yield* processMessageForEvent(message);
	}).pipe(
		// Log parse errors but don't fail the fiber
		Effect.catchAll((error) => {
			// Check if it's a MessageParseError
			if (error && typeof error === "object" && "_tag" in error && error._tag === "MessageParseError") {
				const errMsg = error.jid
					? `Mensaje descifrado fallido (probable cambio de dispositivo del remitente): ${error.jid}`
					: `Error de parseo: ${error.reason}`;
				return Effect.logDebug(errMsg);
			}
			return Effect.logError(`Falló al manejar el mensaje: ${error}`);
		}),
	);

const createMessageHandler = (
	configRef: Ref.Ref<Config>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	appLayer: Layer.Layer<any>,
) => {
	// Run in background fiber - this is the edge of our Effect program
	// where we integrate with Baileys' non-Effect callback system
	return (socket: WASocket, protoMessage: proto.IWebMessageInfo): void => {
		Effect.runFork(handleIncomingMessage(protoMessage, socket, configRef).pipe(Effect.provide(appLayer)));
	};
};

export {
	createMessageHandler,
	handleIncomingMessage,
	logMessageToConsole,
};
