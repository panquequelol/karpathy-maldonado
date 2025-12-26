import makeWASocket, {
	type AuthenticationState,
	type BaileysEventMap,
	type ConnectionState as BaileysConnectionState,
	DisconnectReason,
	type WASocket,
	useMultiFileAuthState,
	type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode-terminal";
import { Effect } from "effect";
import type { ConnectionState } from "./types";
import { baileysLogger } from "./logger";

const AUTH_FOLDER = "auth_info";

type AuthState = ReturnType<typeof useMultiFileAuthState> extends Promise<infer T> ? T : never;

const createAuthState = (): Effect.Effect<AuthState, Error> =>
	Effect.tryPromise({
		try: () => useMultiFileAuthState(AUTH_FOLDER),
		catch: (error) => new Error(`Failed to create auth state: ${error}`),
	});

const createSocketConfig = (authState: AuthState) => ({
	auth: authState.state,
	logger: baileysLogger,
	printQRInTerminal: false,
});

const determineConnectionState = (
	update: Partial<BaileysConnectionState>,
): ConnectionState => {
	const { connection, lastDisconnect } = update;

	if (connection === "close") {
		const statusCode = (lastDisconnect as { error?: Boom } | undefined)?.error?.output?.statusCode;
		const isLoggedOut = statusCode === DisconnectReason.loggedOut;

		return {
			status: isLoggedOut ? "logged-out" : "disconnected",
			shouldReconnect: !isLoggedOut,
		} as const;
	}

	if (connection === "open") {
		return { status: "connected", shouldReconnect: false } as const;
	}

	return { status: "connecting", shouldReconnect: true } as const;
};

const displayQRCode = (qr: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* Effect.log("\n📱 Scan this QR code with WhatsApp → Linked Devices:");
		yield* Effect.sync(() => {
			QRCode.generate(qr, { small: true });
		});
	});

const logConnectionState = (state: ConnectionState): Effect.Effect<void> =>
	Effect.gen(function* () {
		switch (state.status) {
			case "logged-out":
				yield* Effect.logWarning("📴 Logged out from WhatsApp");
				break;
			case "disconnected":
				if (state.shouldReconnect) {
					yield* Effect.log("🔄 Connection closed, reconnecting in 5 seconds...");
				}
				break;
			case "connected":
				yield* Effect.logInfo("✅ Connected to WhatsApp");
				break;
			case "connecting":
				yield* Effect.logDebug("⏳ Connecting to WhatsApp...");
				break;
		}
	});

type ConnectionCallbacks = {
	readonly onStateChange: (state: ConnectionState) => void;
	readonly onConnected: (socket: WASocket) => void;
	readonly onMessage: (message: proto.IWebMessageInfo) => void;
	readonly onReconnect: () => void;
};

const processMessages = (
	event: BaileysEventMap["messages.upsert"],
	handler: (message: proto.IWebMessageInfo) => void,
): Effect.Effect<void> =>
	Effect.forEach(event.messages, (message) =>
		Effect.sync(() => handler(message)),
	);

const connectToWhatsApp = (
	callbacks: ConnectionCallbacks,
): Effect.Effect<WASocket, Error> =>
	Effect.gen(function* () {
		const { state, saveCreds } = yield* createAuthState();

		const socket = makeWASocket(createSocketConfig({ state, saveCreds }));

		yield* Effect.async<void>(
			(resume) => {
				socket.ev.on("connection.update", (update: Partial<BaileysConnectionState>) => {
					const { connection, qr } = update;

					if (qr !== undefined) {
						Effect.runFork(displayQRCode(qr));
					}

					if (connection === undefined) {
						resume(Effect.void);
						return;
					}

					const state = determineConnectionState(update);
					callbacks.onStateChange(state);

					if (state.status === "disconnected" && state.shouldReconnect) {
						setTimeout(callbacks.onReconnect, 5000);
					}

					if (state.status === "connected") {
						callbacks.onConnected(socket);
					}

					Effect.runFork(logConnectionState(state));
					resume(Effect.void);
				});

				socket.ev.on("creds.update", () => {
					Effect.runFork(
						Effect.tryPromise({
							try: () => saveCreds(),
							catch: (error) => new Error(`Failed to save creds: ${error}`),
						}),
					);
				});

				socket.ev.on("messages.upsert", (messages) => {
					Effect.runFork(processMessages(messages, callbacks.onMessage));
				});
			},
		);

		return socket;
	});

export type { ConnectionState, ConnectionCallbacks };
export { connectToWhatsApp, determineConnectionState, processMessages };
