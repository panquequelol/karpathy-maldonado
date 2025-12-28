import { Duration, Effect, Logger, Layer, Ref } from "effect";
import { NodeTerminal } from "@effect/platform-node";
import { connectToWhatsApp, type ConnectionState, BASE_RECONNECT_DELAY_MS, MAX_RECONNECT_RETRIES } from "./src/connection";
import { createMessageHandler } from "./src/message-handler";
import { makeConfigRef, type ConfigRef, type MonitorConfig } from "./src/config";
import { listAllGroups } from "./src/groups";
import { selectGroupInteractively } from "./src/group-selector";
import { OpenRouterServiceLayer, ConfigError } from "./src/openrouter";
import { DatabaseLive, DatabaseConfigError } from "./src/db/connection";
import { EventStorageLive } from "./src/db/event-storage";

let reconnectRetryCount = 0;

/**
 * Application logger layer using Effect's pretty logger.
 * Provides human-readable colored output for development.
 */
const AppLoggerLive = Logger.pretty;

/**
 * Main application layer combining logger, Terminal, OpenRouter config, and database.
 * ConfigError and DatabaseConfigError will be caught at runtime with proper handling.
 */
const AppLayer = Layer.merge(
	AppLoggerLive,
	Layer.merge(
		NodeTerminal.layer,
		Layer.merge(
			Layer.catchAll(OpenRouterServiceLayer, (error) =>
				Layer.die(`OpenRouter configuration failed: ${error.reason}`),
			),
			// Provide Database to EventStorageLive using Layer.provideMerge
			Layer.provideMerge(
				EventStorageLive,
				Layer.catchAll(DatabaseLive, (error) =>
					Layer.die(`Database configuration failed: ${error.reason}`),
				),
			),
		),
	),
);

/**
 * Log configuration summary showing which groups are being monitored.
 */
const logConfigSummary = (configRef: ConfigRef) =>
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
	return (state: ConnectionState, retryCount: number): void => {
		Effect.runFork(
			Effect.gen(function* () {
				switch (state._tag) {
					case "Connected":
						reconnectRetryCount = 0;
						yield* Effect.logInfo("Conectado");
						yield* logConfigSummary(configRef);
						break;
					case "DisconnectedWithReconnect":
						const delaySeconds = (BASE_RECONNECT_DELAY_MS * Math.pow(2.5, retryCount)) / 1000;
						yield* Effect.logWarning(`Desconectado - reconectando en ${delaySeconds.toFixed(1)}s (intento ${retryCount + 1}/${MAX_RECONNECT_RETRIES + 1})...`);
						break;
					case "DisconnectedNoReconnect":
						yield* Effect.logError("Desconectado de WhatsApp");
						break;
					case "LoggedOut":
						yield* Effect.logWarning("Desconectado - escanea el código QR nuevamente");
						break;
					case "Connecting":
						// No action needed
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
) =>
	Effect.gen(function* () {
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
		const runWithLayer = <R, E, A>(effect: Effect.Effect<A, E, R>) => {
			Effect.runFork(Effect.provide(AppLayer)(effect) as Effect.Effect<A, E, never>);
		};

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
			onReconnect: (_retryCount: number, _delay: number) => {
				if (reconnectRetryCount > MAX_RECONNECT_RETRIES) {
					runWithLayer(
						Effect.gen(function* () {
							yield* Effect.logError("Maximos reintentos de conexión alcanzados. Saliendo...");
							yield* Effect.sync(() => process.exit(1));
						}),
					);
					return;
				}
				const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2.5, reconnectRetryCount);
				reconnectRetryCount++;
				setTimeout(() => {
					Effect.runFork(startWhatsAppListener(configRef).pipe(Effect.provide(AppLayer)));
				}, delay);
			},
			runWithLayer,
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
