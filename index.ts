import { Duration, Effect, Logger, Layer } from "effect";
import { connectToWhatsApp, type ConnectionState } from "./src/connection";
import { createMessageHandler } from "./src/message-handler";
import { loadConfig, type Config } from "./src/config";
import { listAllGroups, logGroupsForDiscovery } from "./src/groups";
import { OpenRouterServiceLayer, ConfigError } from "./src/openrouter";

/**
 * Application logger layer using Effect's pretty logger.
 * Provides human-readable colored output for development.
 */
const AppLoggerLive = Logger.pretty;

/**
 * Main application layer combining logger and OpenRouter config.
 * ConfigError will be caught at runtime with proper handling.
 */
const AppLayer = Layer.merge(
	AppLoggerLive,
	Layer.catchAll(OpenRouterServiceLayer, (error) =>
		Layer.die(`OpenRouter configuration failed: ${error.reason}`),
	),
);

/**
 * Log configuration summary showing which groups are being monitored.
 */
const logConfigSummary = (config: Config): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (config.mode === "monitor") {
			const count = config.allowedGroupJids.length;
			yield* Effect.log(`Listening to ${count} group${count === 1 ? "" : "s"}: ${config.allowedGroupJids.join(", ")}`);
		}
	});

/**
 * Handle connection state changes from Baileys.
 * This is called from non-Effect code, so we run the Effect in the background.
 */
const handleConnectionChange = (config: Config) => {
	return (state: ConnectionState): void => {
		Effect.runFork(
			Effect.gen(function* () {
				switch (state.status) {
					case "connected":
						yield* Effect.logInfo("Connected");
						yield* logConfigSummary(config);
						break;
					case "disconnected":
						if (state.shouldReconnect) {
							yield* Effect.logWarning("Disconnected - reconnecting...");
						} else {
							yield* Effect.logError("Disconnected from WhatsApp");
						}
						break;
					case "logged-out":
						yield* Effect.logWarning("Logged out - scan QR code again");
						break;
				}
			}).pipe(Effect.provide(AppLayer)),
		);
	};
};

/**
 * Handle post-connection tasks like listing groups for discovery.
 */
const handleConnected = (socket: import("@whiskeysockets/baileys").WASocket, config: Config) =>
	Effect.gen(function* () {
		if (config.mode === "discovery") {
			const groups = yield* listAllGroups(socket);
			yield* logGroupsForDiscovery(groups);
			yield* Effect.sync(() => process.exit(0));
		}
	});

/**
 * Main WhatsApp listener program.
 */
const startWhatsAppListener = (config: Config) =>
	Effect.gen(function* () {
		const handleMessage = createMessageHandler(config, AppLayer);

		yield* connectToWhatsApp({
			onStateChange: handleConnectionChange(config),
			onConnected: (socket) => {
				Effect.runFork(handleConnected(socket, config).pipe(Effect.provide(AppLayer)));
			},
			onMessage: handleMessage,
			onReconnect: () => {
				Effect.runFork(startWhatsAppListener(config).pipe(Effect.provide(AppLayer)));
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
	const config = yield* loadConfig();
	yield* startWhatsAppListener(config);
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
