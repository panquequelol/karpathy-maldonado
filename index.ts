import { Duration, Effect, Logger } from "effect";
import { connectToWhatsApp, type ConnectionState } from "./src/connection";
import { createMessageHandler } from "./src/message-handler";
import { loadConfig, type Config } from "./src/config";
import { listAllGroups, logGroupsForDiscovery } from "./src/groups";

/**
 * Application logger layer using Effect's pretty logger.
 * Provides human-readable colored output for development.
 */
const AppLoggerLive = Logger.pretty;

/**
 * Log configuration summary showing which groups are being monitored.
 */
const logConfigSummary = (config: Config): Effect.Effect<void> =>
	Effect.gen(function* () {
		const count = config.allowedGroupJids.length;
		const groupWord = count === 1 ? "group" : "groups";
		yield* Effect.log(`🎧 Listening to ${count} ${groupWord}`);
		for (const jid of config.allowedGroupJids) {
			yield* Effect.log(`   - ${jid}`);
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
					case "connecting":
						yield* Effect.logDebug("⏳ Connecting to WhatsApp...");
						break;
					case "connected":
						yield* Effect.logInfo("✅ Connected!");
						yield* logConfigSummary(config);
						break;
					case "disconnected":
						yield* Effect.logError("❌ Disconnected from WhatsApp");
						break;
					case "logged-out":
						yield* Effect.logWarning("🚪 Logged out - please scan QR code again");
						break;
				}
			}).pipe(Effect.provide(AppLoggerLive)),
		);
	};
};

/**
 * Handle post-connection tasks like listing groups.
 */
const handleConnected = (socket: import("@whiskeysockets/baileys").WASocket, config: Config) =>
	Effect.gen(function* () {
		if (config.listGroupsOnStart) {
			const groups = yield* Effect.tryPromise({
				try: () => listAllGroups(socket),
				catch: (error) => new Error(`Failed to list groups: ${error}`),
			});
			yield* Effect.sync(() => logGroupsForDiscovery(groups));
		}
	});

/**
 * Main WhatsApp listener program.
 */
const startWhatsAppListener = (config: Config) =>
	Effect.gen(function* () {
		yield* Effect.log("🚀 Starting WhatsApp Group Message Listener");

		const handleMessage = createMessageHandler(config);

		yield* connectToWhatsApp({
			onStateChange: handleConnectionChange(config),
			onConnected: (socket) => {
				Effect.runFork(handleConnected(socket, config).pipe(Effect.provide(AppLoggerLive)));
			},
			onMessage: handleMessage,
			onReconnect: () => {
				Effect.runFork(startWhatsAppListener(config).pipe(Effect.provide(AppLoggerLive)));
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
		Effect.provide(AppLoggerLive),
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* Effect.logError(`💥 Fatal error: ${error}`);
				yield* Effect.sync(() => process.exit(1));
			}),
		),
	),
);
