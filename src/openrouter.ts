import { Effect, Layer, Data, Schema, Context, Config, Secret } from "effect";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

export type OpenRouterConfig = {
	readonly apiKey: string;
	readonly model: string;
};

export class ConfigError extends Data.TaggedError("ConfigError")<{
	readonly reason: string;
}> {
	override readonly message = "OpenRouter configuration error";
}

export const OpenRouterConfig = Context.GenericTag<OpenRouterConfig>("OpenRouterConfig");

export const loadConfig = (): Effect.Effect<OpenRouterConfig, ConfigError> =>
	Effect.gen(function* () {
		const apiKeySecret = yield* Config.secret("OPENROUTER_API_KEY").pipe(
			Config.withDescription("OpenRouter API key"),
		);
		const model = yield* Config.string("OPENROUTER_MODEL").pipe(
			Config.withDescription("OpenRouter model identifier"),
		);
		const apiKey = Secret.value(apiKeySecret);

		return { apiKey, model } as const;
	}).pipe(
		Effect.mapError((error) => new ConfigError({ reason: String(error) })),
	);

const ClassificationResponseSchema = Schema.Union(
	Schema.Literal("0"),
	Schema.Literal("1"),
);

const LocationSchema = Schema.Struct({
	type: Schema.Union(
		Schema.Literal("IN-PERSON"),
		Schema.Literal("ONLINE"),
	),
	fullAddress: Schema.NullOr(Schema.String),
});

const EventSchema = Schema.Struct({
	slug: Schema.String,
	title: Schema.String,
	description: Schema.String,
	organizer: Schema.String,
	startAt: Schema.String,
	endAt: Schema.NullOr(Schema.String),
	location: LocationSchema,
});

export type Event = Schema.Schema.Type<typeof EventSchema>;
export type Location = Schema.Schema.Type<typeof LocationSchema>;
export type LocationType = "IN-PERSON" | "ONLINE";

export class OpenRouterError extends Data.TaggedError("OpenRouterError")<{
	readonly reason: string;
	readonly statusCode?: number;
	readonly body?: string;
}> {
	override readonly message = "OpenRouter API request failed";
}

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
	readonly retryAfter?: number;
}> {
	override readonly message = "OpenRouter rate limit exceeded, backing off";
}

export class NetworkError extends Data.TaggedError("NetworkError")<{
	readonly reason: string;
}> {
	override readonly message = "Network request failed";
}

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
	readonly timeoutMs: number;
}> {
	override readonly message = "Request timed out";
}

export class ModelNotFoundError extends Data.TaggedError("ModelNotFoundError")<{
	readonly model: string;
}> {
	override readonly message = "Model not found on OpenRouter";
}

export class SchemaValidationError extends Data.TaggedError("SchemaValidationError")<{
	readonly reason: string;
	readonly path?: string;
}> {
	override readonly message = "Response failed schema validation";
}

export class ClassificationError extends Data.TaggedError("ClassificationError")<{
	readonly reason: string;
}> {
	override readonly message = "Failed to classify message as event or noise";
}

export class ExtractionError extends Data.TaggedError("ExtractionError")<{
	readonly reason: string;
}> {
	override readonly message = "Failed to extract event data from message";
}

const isRetryableStatusCode = (status: number): boolean =>
	status === 429 || // Rate limit
	status === 500 || // Internal server error
	status === 502 || // Bad gateway
	status === 503 || // Service unavailable
	status === 504; // Gateway timeout

const createClassificationPrompt = (rawText: string): string => {
	const systemPrompt = `You are a Data Feasibility Validator. Your task is to classify text as either a **Parsable Event (1)** or **Noise/Notification (0)**.

### The Objective
Determine if the input text contains the "Raw Materials" necessary to populate a database schema with a specific \`startAt\` timestamp (Date + Time) and \`title\`.

### Classification Logic

**Return \`1\` (Parsable Event)** if and only if:
1. **Explicit Date:** The text contains a specific calendar date (e.g., "Dec 10", "Thursday 18th", "Tomorrow").
2. **Explicit Time:** The text contains a specific clock time (e.g., "14:00", "6 pm").
3. **Independence:** The text is a standalone listing, not dependent on the message timestamp (i.e., it doesn't rely solely on "starting now").

**Return \`0\` (Noise/Notification)** if:
1. **Relative Urgency:** It uses *only* relative time (e.g., "Starting in 30 mins", "Live now", "Join the room").
2. **Missing Coordinates:** It lacks either the Date or the Time.
3. **Vague:** It is general conversation or a partial fragment.

### Ground Truth Examples

**Input:**
"🚨 Equipo, la sesión más importante de la semana comienza en menos de 30 minutos!!! Hoy revisaremos en detalle cómo piensan los inversionistas. Les dejo el link VIP de Zoom..."
**Output:**
0
**(Reason: Relies on "starts in 30 minutes". No explicit calendar date or clock time to parse.)**

**Input:**
"Desde el Departamento de Innovación... te invitamos a HubConnect. 📆Día: Jueves 18/12 de 10:00 a 13:00 hrs 📍Lugar: Hub Providencia..."
**Output:**
1
**(Reason: Contains explicit date "18/12" and time "10:00", allowing for precise extraction.)**`;

	const userPrompt = `### Input Text
${rawText}

### Output
(Return ONLY \`0\` or \`1\`)`;

	return JSON.stringify([
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	]);
};

const createExtractionPrompt = (rawText: string, currentDate: string): string => {
	const systemPrompt = `Eres un motor de extracción de eventos de alta precisión. Tu objetivo es convertir texto no estructurado en un array JSON estricto.

### Contexto
Fecha Actual: ${currentDate} (Úsala para resolver fechas relativas como "mañana" o "el próximo jueves").
Zona Horaria por Defecto: America/Santiago (GMT-3) a menos que se especifique otra.

### Esquema de Salida
Retorna ÚNICAMENTE un array JSON con esta estructura exacta:

{
  "slug": "string (kebab-case-identificador-unico)",
  "title": "string (título limpio en español, sin emojis)",
  "description": "string (máximo 1 oración, < 20 palabras, resumen de alto valor en español)",
  "organizer": "string (nombre de la entidad)",
  "startAt": "string (ISO 8601 con offset, ej: 2025-12-18T10:00:00-03:00)",
  "endAt": "string | null (ISO 8601 con offset)",
  "location": {
    "type": "IN-PERSON" | "ONLINE",
    "fullAddress": "string | null (si es IN-PERSON: 'Lugar, Dirección, Ciudad'; si es ONLINE: null)"
  }
}

### Reglas de Parseo
1. Idioma: TODOS los campos de texto (título, descripción, ubicación) deben estar en ESPAÑOL. Traduce si el input está en inglés.
2. Reducción de Ruido: Elimina el relleno de marketing ("Tenemos el agrado de invitarte..."). Mantén solo la propuesta de valor central.
3. Fechas: Calcula siempre el año específico basado en ${currentDate}. Si estamos en diciembre y el evento es en enero, asume el próximo año.
4. Lógica de Ubicación:
   - Si solo hay una URL (Zoom/Meet), type es "ONLINE".
   - Si se menciona una dirección física o ciudad, type es "IN-PERSON".
5. Nulls: Si \`endAt\` no se especifica, usa null. No adivines la duración.`;

	const userPrompt = `### Texto de Entrada
${rawText}

### Output
Retorna ÚNICAMENTE el objeto JSON (sin markdown, sin bloques de código):`;

	return JSON.stringify([
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	]);
};

const fetchWithTimeout = (
	url: string,
	options: RequestInit,
	timeoutMs: number,
): Effect.Effect<Response, TimeoutError | NetworkError> =>
	Effect.tryPromise({
		try: () =>
			Promise.race([
				fetch(url, options),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Request timeout")), timeoutMs),
				),
			]),
		catch: (error) => {
			if (error instanceof Error && error.message === "Request timeout") {
				return new TimeoutError({ timeoutMs });
			}
			return new NetworkError({ reason: String(error) });
		},
	});

const parseApiResponse = (responseBody: string): Effect.Effect<
	{ content: string },
	SchemaValidationError | OpenRouterError
> =>
	Effect.gen(function* () {
		const json = yield* Schema.decodeUnknown(Schema.parseJson())(responseBody).pipe(
			Effect.mapError((error) => new SchemaValidationError({ reason: `Invalid JSON response: ${error}` })),
		);

		const responseSchema = Schema.Struct({
			choices: Schema.Array(
				Schema.Struct({
					message: Schema.Struct({
						content: Schema.String,
					}),
				}),
			),
		});

		const parsed = yield* Schema.decodeUnknown(responseSchema)(json).pipe(
			Effect.mapError((error) => new SchemaValidationError({ reason: `Invalid response structure: ${error}` })),
		);

		const content = parsed.choices[0]?.message?.content;
		if (!content) {
			return yield* Effect.fail(new SchemaValidationError({ reason: "Empty content in API response" }));
		}

		return { content };
	});

const postChatCompletion = (
	messagesJson: string,
	config: OpenRouterConfig,
	maxTokens: number,
	responseFormat?: "json_object" | "text",
): Effect.Effect<
	string,
	OpenRouterError | RateLimitError | NetworkError | TimeoutError | ModelNotFoundError | SchemaValidationError
> =>
	Effect.gen(function* () {
		const requestBody = JSON.stringify({
			model: config.model,
			messages: JSON.parse(messagesJson),
			temperature: 0.1,
			max_tokens: maxTokens,
			...(responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {}),
		});

		yield* Effect.logDebug(`Calling OpenRouter API with model: ${config.model}`);

		const response = yield* fetchWithTimeout(
			`${OPENROUTER_API_URL}/chat/completions`,
			{
				method: "POST",
				headers: {
					"Authorization": `Bearer ${config.apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://github.com",
				},
				body: requestBody,
			},
			REQUEST_TIMEOUT_MS,
		);

		if (response.status !== 200) {
			const errorBody = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: () => "",
			}).pipe(Effect.orElse(() => Effect.succeed("")));

			yield* Effect.logError(`API error ${response.status}: ${errorBody}`);

			if (response.status === 404) {
				return yield* Effect.fail(new ModelNotFoundError({ model: config.model }));
			}

			if (response.status === 429) {
				const retryAfter = response.headers.get("Retry-After");
				return yield* Effect.fail(
					new RateLimitError({
						retryAfter: retryAfter ? Number.parseInt(retryAfter, 10) : undefined,
					}),
				);
			}

			return yield* Effect.fail(
				new OpenRouterError({
					reason: `API request failed with status ${response.status}`,
					statusCode: response.status,
					body: errorBody,
				}),
			);
		}

		const responseBody = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (error) => new NetworkError({ reason: `Failed to read response: ${error}` }),
		});

		const { content } = yield* parseApiResponse(responseBody);
		return content;
	});

const isRetryableError = (error: unknown): error is RateLimitError | OpenRouterError => {
	if (!error || typeof error !== "object" || !("_tag" in error)) {
		return false;
	}
	const tagged = error as { _tag: string; statusCode?: number };
	return (
		tagged._tag === "RateLimitError" ||
		(tagged._tag === "OpenRouterError" && tagged.statusCode !== undefined && isRetryableStatusCode(tagged.statusCode))
	);
};

const postChatCompletionWithRetry = (
	messagesJson: string,
	config: OpenRouterConfig,
	maxTokens: number,
	responseFormat?: "json_object" | "text",
	attempt = 1,
): Effect.Effect<
	string,
	OpenRouterError | RateLimitError | NetworkError | TimeoutError | ModelNotFoundError | SchemaValidationError
> =>
	Effect.gen(function* () {
		const result = yield* Effect.either(postChatCompletion(messagesJson, config, maxTokens, responseFormat));

		if (result._tag === "Right") {
			return result.right;
		}

		const error = result.left;
		if (isRetryableError(error) && attempt <= MAX_RETRIES) {
			const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
			yield* Effect.logWarning(`Retry ${attempt}/${MAX_RETRIES} after ${error._tag}: ${error.message} (waiting ${delayMs}ms)`);
			yield* Effect.sleep(`${delayMs} millis`);
			return yield* postChatCompletionWithRetry(messagesJson, config, maxTokens, responseFormat, attempt + 1);
		}

		return yield* Effect.fail(error);
	});

export const classifyMessage = (
	text: string,
): Effect.Effect<
	boolean,
	ClassificationError,
	OpenRouterConfig
> =>
	Effect.gen(function* () {
		if (!text || text.trim().length === 0) {
			return false;
		}

		const config = yield* OpenRouterConfig;
		const messagesJson = createClassificationPrompt(text);
		const content = yield* postChatCompletionWithRetry(messagesJson, config, 100);

		yield* Effect.logInfo(`Raw classification response: "${content}"`);

		const cleaned = String(content)
			.replace(/```json\n?/g, "")
			.replace(/```\n?/g, "")
			.trim();

		const validResponse = yield* Schema.decodeUnknown(ClassificationResponseSchema)(cleaned).pipe(
			Effect.mapError(
				(error) => new SchemaValidationError({ reason: `Invalid classification response: ${error}` }),
			),
		);

		if (validResponse === "1") {
			yield* Effect.logInfo("Message classified as parsable event");
			return true;
		}

		yield* Effect.logInfo("Message classified as noise");
		return false;
	}).pipe(
		Effect.catchAll((error) =>
			Effect.fail(new ClassificationError({ reason: formatError(error) })),
		),
	);

export const extractEvent = (
	text: string,
): Effect.Effect<Event, ExtractionError, OpenRouterConfig> =>
	Effect.gen(function* () {
		const config = yield* OpenRouterConfig;
		const currentDate = new Date().toISOString().split("T")[0] ?? "";
		const messagesJson = createExtractionPrompt(text, currentDate);
		const content = yield* postChatCompletionWithRetry(messagesJson, config, 1000, "json_object");

		yield* Effect.logInfo(`Raw extraction response: "${content}"`);

		const cleaned = String(content)
			.replace(/```json\n?/g, "")
			.replace(/```\n?/g, "")
			.trim();

		yield* Effect.logInfo(`Cleaned extraction response: "${cleaned}"`);

		const parsedJson = yield* Schema.decodeUnknown(Schema.parseJson())(cleaned).pipe(
			Effect.mapError((error) => new SchemaValidationError({ reason: `Invalid JSON: ${error}` })),
		);

		yield* Effect.logInfo(`Parsed JSON: ${JSON.stringify(parsedJson, null, 2)}`);

		const event = yield* Schema.decodeUnknown(EventSchema)(parsedJson).pipe(
			Effect.mapError((error) => new SchemaValidationError({ reason: `Invalid event schema: ${error}` })),
		);

		yield* Effect.logInfo(`Extracted event: "${event.title}" at ${event.startAt}`);
		return event;
	}).pipe(
		Effect.catchAll((error) =>
			Effect.fail(new ExtractionError({ reason: formatError(error) })),
		),
	);

const formatError = (error: unknown): string => {
	if (error && typeof error === "object" && "_tag" in error) {
		const tagged = error as { _tag: string; message?: string };
		if (tagged.message) return `[${tagged._tag}] ${tagged.message}`;
		return `[${tagged._tag}] ${JSON.stringify(error)}`;
	}
	if (error instanceof Error) return error.message;
	return String(error);
};

export const OpenRouterServiceLayer = Layer.effect(
	OpenRouterConfig,
	loadConfig(),
);
