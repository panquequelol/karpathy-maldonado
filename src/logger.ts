import { Logger } from "effect";

/**
 * Effect logger with pretty output for human-readable console logs.
 * This is a Layer that can be provided to the application.
 */
export const appLoggerLayer = Logger.pretty;

/**
 * Pino-compatible logger bridge for Baileys.
 * Baileys requires a logger with `child()` method.
 */
interface PinoLogDescriptor {
	level: string;
	time: number;
	[key: string]: unknown;
}

type LogFn = (obj: unknown, msg?: string, ...args: unknown[]) => void;

interface PinoLogger {
	level: string;
	child(): PinoLogger;
	error: LogFn;
	warn: LogFn;
	info: LogFn;
	debug: LogFn;
	trace: LogFn;
	log: LogFn;
}

const createPinoCompatibleLogger = (): PinoLogger => {
	const logFn = (level: string): LogFn => {
		return (obj: unknown, msg?: string): void => {
			const descriptor: PinoLogDescriptor = {
				level,
				time: Date.now(),
			};

			if (typeof obj === "object" && obj !== null) {
				Object.assign(descriptor, obj);
			} else if (obj !== undefined) {
				descriptor.msg = String(obj);
			}

			if (msg !== undefined) {
				descriptor.msg = descriptor.msg ? `${descriptor.msg} ${msg}` : msg;
			}

			// Suppress verbose Baileys logs - only log errors
			if (level === "error") {
				console.log(JSON.stringify(descriptor));
			}
		};
	};

	return {
		level: "error",
		child(): PinoLogger {
			return createPinoCompatibleLogger();
		},
		error: logFn("error"),
		warn: logFn("warn"),
		info: logFn("info"),
		debug: logFn("debug"),
		trace: logFn("trace"),
		log: logFn("info"),
	};
};

/**
 * Pino-compatible logger for Baileys (suppresses verbose logs).
 * This is a bridge between Effect's logging and Baileys' expectations.
 */
export const baileysLogger = createPinoCompatibleLogger();
