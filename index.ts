import { Duration, Effect, Logger, Layer, Ref } from "effect";
import { NodeTerminal } from "@effect/platform-node";
import { connectToWhatsApp, type ConnectionState } from "./src/connection";
import { createMessageHandler } from "./src/message-handler";
import { makeConfigRef, type ConfigRef, type MonitorConfig } from "./src/config";
import { listAllGroups } from "./src/groups";
import { selectGroupInteractively } from "./src/group-selector";
import { OpenRouterServiceLayer, ConfigError } from "./src/openrouter";

/**
 * Application logger layer using Effect's pretty logger.
 * Provides human-readable colored output for development.
 */
const AppLoggerLive = Logger.pretty;

/**
 * Main application layer combining logger, Terminal, and OpenRouter config.
 * ConfigError will be caught at runtime with proper handling.
 */
const AppLayer = Layer.merge(
	AppLoggerLive,
	Layer.merge(
		NodeTerminal.layer,
		Layer.catchAll(OpenRouterServiceLayer, (error) =>
			Layer.die(`OpenRouter configuration failed: ${error.reason}`),
		),
	),
);

/**
 * Log configuration summary showing which groups are being monitored.
 */
const logConfigSummary = (configRef: ConfigRef): Effect.Effect<void> =>
	Effect.gen(function* () {
		const config = yield* Ref.get(configRef);
		if (config.mode === "monitor") {
			const count = config.allowedGroupJids.length;
			const plural = count === 1 ? "grupo" : "grupos";
			yield* Effect.log(`Escuchando ${count} ${plural}: ${config.allowedGroupJids.join(", ")}`);
		}
	});

/**
 * Handle connection state changes from Baileys.
 * This is called from non-Effect code, so we run the Effect in the background.
 */
const handleConnectionChange = (configRef: ConfigRef) => {
	return (state: ConnectionState): void => {
		Effect.runFork(
			Effect.gen(function* () {
				switch (state.status) {
					case "connected":
						yield* Effect.logInfo("Conectado");
						yield* logConfigSummary(configRef);
						break;
					case "disconnected":
						if (state.shouldReconnect) {
							yield* Effect.logWarning("Desconectado - reconectando...");
						} else {
							yield* Effect.logError("Desconectado de WhatsApp");
						}
						break;
					case "logged-out":
						yield* Effect.logWarning("Desconectado - escanea el código QR nuevamente");
						break;
				}
			}).pipe(Effect.provide(AppLayer)),
		);
	};
};

/**
 * Handle post-connection tasks like listing groups for discovery.
 * Updates the configRef when a group is selected in discovery mode.
 */
const handleConnected = (
	socket: import("@whiskeysockets/baileys").WASocket,
	configRef: ConfigRef,
) => Effect.gen(function* () {
		const config = yield* Ref.get(configRef);

		if (config.mode === "discovery") {
			const groups = yield* listAllGroups(socket);

			if (groups.length === 0) {
				yield* Effect.logError("No se encontraron grupos de WhatsApp");
				yield* Effect.sync(() => process.exit(1));
				return;
			}

			const selectedGroup = yield* selectGroupInteractively(groups);
			const monitorConfig: MonitorConfig = {
				mode: "monitor",
				allowedGroupJids: [selectedGroup.id],
			} as const;

			yield* Ref.set(configRef, monitorConfig);
			yield* Effect.logInfo(`Monitoreando ahora: ${selectedGroup.id}`);
		}
	});

/**
 * Main WhatsApp listener program.
 */
const startWhatsAppListener = (configRef: ConfigRef) =>
	Effect.gen(function* () {
		const handleMessage = createMessageHandler(configRef, AppLayer);

		const socket = yield* connectToWhatsApp({
			onStateChange: handleConnectionChange(configRef),
			onConnected: (socket) => {
				Effect.runFork(
					handleConnected(socket, configRef).pipe(
						Effect.provide(AppLayer),
					),
				);
			},
			onMessage: handleMessage,
			onReconnect: () => {
				Effect.runFork(startWhatsAppListener(configRef).pipe(Effect.provide(AppLayer)));
			},
		});

		// Keep the Effect alive indefinitely - the socket event handlers
		// will process messages in background fibers
		yield* Effect.forever(Effect.sleep(Duration.seconds(60)));
	});

/**
 * Root program that loads config and starts the listener.
 */
const program = Effect.gen(function* () {
	const configRef = yield* makeConfigRef();
	yield* startWhatsAppListener(configRef);
});

/**
 * Run the program at the edge with pretty logger.
 * This is the only place where Effect.run* is called.
 */
Effect.runPromise(
	program.pipe(
		Effect.provide(AppLayer),
		Effect.catchTag("ConfigError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(`Configuration error: ${error.reason}`);
				yield* Effect.logError("Please set OPENROUTER_API_KEY and OPENROUTER_MODEL environment variables");
				yield* Effect.sync(() => process.exit(1));
			}),
		),
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* Effect.logError(`Fatal error: ${error}`);
				yield* Effect.sync(() => process.exit(1));
			}),
		),
	),
);
