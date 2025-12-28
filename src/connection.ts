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
const BASE_RECONNECT_DELAY_MS = 2500;
const MAX_RECONNECT_RETRIES = 5;

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

		if (isLoggedOut) {
			return { _tag: "LoggedOut" };
		}

		const isConflict = statusCode === DisconnectReason.connectionClosed;
		return { _tag: "DisconnectedWithReconnect", isConflict };
	}

	if (connection === "open") {
		return { _tag: "Connected" };
	}

	return { _tag: "Connecting" };
};

const displayQRCode = (qr: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* Effect.log("\nEscanea el código QR con WhatsApp → Dispositivos vinculados:");
		yield* Effect.sync(() => {
			QRCode.generate(qr, { small: true });
		});
	});

const logConnectionState = (state: ConnectionState, retryCount: number = 0): Effect.Effect<void> =>
	Effect.gen(function* () {
		switch (state._tag) {
			case "LoggedOut":
				yield* Effect.logWarning("Desconectado de WhatsApp");
				break;
			case "DisconnectedNoReconnect":
				yield* Effect.logError("Desconectado de WhatsApp");
				break;
			case "DisconnectedWithReconnect":
				if (state.isConflict) {
					yield* Effect.logWarning("Sesión reemplazada (otro dispositivo conectó)");
				}
				if (retryCount >= MAX_RECONNECT_RETRIES) {
					yield* Effect.logError("Maximos reintentos de conexión alcanzados. Saliendo...");
				}
				break;
			case "Connected":
				yield* Effect.logInfo("Conectado a WhatsApp");
				break;
			case "Connecting":
				// No logging needed for connecting state
				break;
		}
	});

type ConnectionCallbacks = {
	readonly onStateChange: (state: ConnectionState, retryCount: number) => void;
	readonly onConnected: (socket: WASocket) => void;
	readonly onMessage: (socket: WASocket, message: proto.IWebMessageInfo) => void;
	readonly onReconnect: (retryCount: number, delay: number) => void;
	readonly runWithLayer: <R, E, A>(effect: Effect.Effect<A, E, R>) => void;
};

const processMessages = (
	event: BaileysEventMap["messages.upsert"],
	socket: WASocket,
	handler: (socket: WASocket, message: proto.IWebMessageInfo) => void,
): Effect.Effect<void> =>
	Effect.forEach(event.messages, (message) =>
		Effect.sync(() => handler(socket, message)),
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
						callbacks.runWithLayer(displayQRCode(qr));
					}

					if (connection === undefined) {
						resume(Effect.void);
						return;
					}

					const state = determineConnectionState(update);
					callbacks.onStateChange(state, 0);

					if (state._tag === "DisconnectedWithReconnect") {
						callbacks.onReconnect(0, BASE_RECONNECT_DELAY_MS);
					}

					if (state._tag === "Connected") {
						callbacks.onConnected(socket);
					}

					callbacks.runWithLayer(logConnectionState(state, 0));
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
					Effect.runFork(processMessages(messages, socket, callbacks.onMessage));
				});
			},
		);

		return socket;
	});

export type { ConnectionState, ConnectionCallbacks };
export { connectToWhatsApp, determineConnectionState, processMessages, BASE_RECONNECT_DELAY_MS, MAX_RECONNECT_RETRIES };
