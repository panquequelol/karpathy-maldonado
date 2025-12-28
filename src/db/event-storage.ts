import { Effect, Data, Schema, Context, Layer } from "effect";
import { eq, asc } from "drizzle-orm";
import { events, type InsertEvent } from "./schema.js";
import type { Database } from "./connection.js";
import { Database as DatabaseContext } from "./connection.js";
import { whatsappMessageToMarkdown } from "./markdown.js";
import type { Event } from "../openrouter.js";
import type { GroupJid, UserJid } from "../types.js";

export type EventToSave = {
	readonly event: Event;
	readonly messageBody: string;
	readonly whatsappMessageId: string;
	readonly whatsappGroupJid: GroupJid;
	readonly whatsappSenderJid: UserJid;
};

export class EventStorageError extends Data.TaggedError("EventStorageError")<{
	readonly reason: string;
}> {
	override readonly message = "Failed to store event";
}

export class EventNotFoundError extends Data.TaggedError("EventNotFoundError")<{
	readonly slug: string;
}> {
	override readonly message = "Event not found";
}

export class DuplicateEventError extends Data.TaggedError("DuplicateEventError")<{
	readonly slug: string;
	readonly whatsappMessageId: string;
}> {
	override readonly message = "Event already exists";
}

export type EventStorage = {
	readonly saveEvent: (event: EventToSave) => Effect.Effect<void, EventStorageError | DuplicateEventError>;
	readonly findEventBySlug: (slug: string) => Effect.Effect<StoredEvent, EventNotFoundError | EventStorageError>;
	readonly findEventByWhatsAppMessageId: (messageId: string) => Effect.Effect<StoredEvent, EventNotFoundError | EventStorageError>;
	readonly listAllEvents: () => Effect.Effect<ReadonlyArray<StoredEvent>, EventStorageError>;
	readonly deleteEvent: (slug: string) => Effect.Effect<void, EventNotFoundError | EventStorageError>;
};

export const EventStorage = Context.GenericTag<EventStorage>("EventStorage");

const StoredEventSchema = Schema.Struct({
	id: Schema.Number,
	slug: Schema.String,
	title: Schema.String,
	description: Schema.String,
	organizer: Schema.String,
	startAt: Schema.String,
	endAt: Schema.NullOr(Schema.String),
	locationType: Schema.Union(Schema.Literal("IN-PERSON"), Schema.Literal("ONLINE")),
	fullAddress: Schema.NullOr(Schema.String),
	messageBody: Schema.String,
	whatsappMessageId: Schema.String,
	whatsappGroupJid: Schema.String,
	whatsappSenderJid: Schema.String,
	createdAt: Schema.String,
	updatedAt: Schema.String,
});

export type StoredEvent = Schema.Schema.Type<typeof StoredEventSchema>;

const toStoredEvent = (raw: unknown): Effect.Effect<StoredEvent, EventStorageError> =>
	Schema.decodeUnknown(StoredEventSchema)(raw).pipe(
		Effect.mapError((error) => new EventStorageError({ reason: `Invalid stored event shape: ${error}` })),
	);

const insertEventFromInput = (input: EventToSave): InsertEvent => {
	const now = Math.floor(Date.now() / 1000);
	const markdownBody = whatsappMessageToMarkdown(input.messageBody);

	return {
		slug: input.event.slug,
		title: input.event.title,
		description: input.event.description,
		organizer: input.event.organizer,
		startAt: input.event.startAt,
		endAt: input.event.endAt,
		locationType: input.event.location.type,
		fullAddress: input.event.location.fullAddress,
		messageBody: markdownBody,
		whatsappMessageId: input.whatsappMessageId,
		whatsappGroupJid: input.whatsappGroupJid,
		whatsappSenderJid: input.whatsappSenderJid,
		createdAt: now,
		updatedAt: now,
	} as const;
};

const convertTimestampToIso = (unixSeconds: number): string =>
	new Date(unixSeconds * 1000).toISOString();

export const EventStorageLive = Layer.effect(
	EventStorage,
	Effect.gen(function* () {
		const db = yield* DatabaseContext;

		const saveEvent = (input: EventToSave): Effect.Effect<void, EventStorageError | DuplicateEventError> =>
			Effect.gen(function* () {
				const data = insertEventFromInput(input);

				yield* Effect.tryPromise({
					try: () => db.insert(events).values(data),
					catch: (error) => {
						const errorMsg = error instanceof Error ? error.message : String(error);
						if (errorMsg.includes("UNIQUE constraint failed")) {
							return new DuplicateEventError({
								slug: input.event.slug,
								whatsappMessageId: input.whatsappMessageId,
							});
						}
						return new EventStorageError({ reason: `Failed to insert event: ${errorMsg}` });
					},
				});

				yield* Effect.logInfo(`Event saved: "${input.event.title}" (slug: ${input.event.slug})`);
			});

		const findEventBySlug = (slug: string): Effect.Effect<StoredEvent, EventNotFoundError | EventStorageError> =>
			Effect.gen(function* () {
				const result = yield* Effect.tryPromise({
					try: () => db.select().from(events).where(eq(events.slug, slug)).limit(1),
					catch: (error) => new EventStorageError({ reason: `Database query failed: ${error}` }),
				});

				const event = result.at(0);
				if (!event) {
					return yield* Effect.fail(new EventNotFoundError({ slug }));
				}

				return yield* toStoredEvent({
					...event,
					createdAt: convertTimestampToIso(event.createdAt),
					updatedAt: convertTimestampToIso(event.updatedAt),
				});
			});

		const findEventByWhatsAppMessageId = (
			messageId: string,
		): Effect.Effect<StoredEvent, EventNotFoundError | EventStorageError> =>
			Effect.gen(function* () {
				const result = yield* Effect.tryPromise({
					try: () => db.select().from(events).where(eq(events.whatsappMessageId, messageId)).limit(1),
					catch: (error) => new EventStorageError({ reason: `Database query failed: ${error}` }),
				});

				const event = result.at(0);
				if (!event) {
					return yield* Effect.fail(new EventNotFoundError({ slug: messageId }));
				}

				return yield* toStoredEvent({
					...event,
					createdAt: convertTimestampToIso(event.createdAt),
					updatedAt: convertTimestampToIso(event.updatedAt),
				});
			});

		const listAllEvents = (): Effect.Effect<ReadonlyArray<StoredEvent>, EventStorageError> =>
			Effect.gen(function* () {
				const result = yield* Effect.tryPromise({
					try: () => db.select().from(events).orderBy(asc(events.startAt)),
					catch: (error) => new EventStorageError({ reason: `Database query failed: ${error}` }),
				});

				return yield* Effect.all(
					result.map((event) =>
						toStoredEvent({
							...event,
							createdAt: convertTimestampToIso(event.createdAt),
							updatedAt: convertTimestampToIso(event.updatedAt),
						}),
					),
					{ concurrency: 10 },
				);
			});

		const deleteEvent = (slug: string): Effect.Effect<void, EventNotFoundError | EventStorageError> =>
			Effect.gen(function* () {
				const result = yield* Effect.tryPromise({
					try: () => db.delete(events).where(eq(events.slug, slug)).returning(),
					catch: (error) => new EventStorageError({ reason: `Database delete failed: ${error}` }),
				});

				if (result.length === 0) {
					return yield* Effect.fail(new EventNotFoundError({ slug }));
				}

				yield* Effect.logInfo(`Event deleted: ${slug}`);
			});

		return {
			saveEvent,
			findEventBySlug,
			findEventByWhatsAppMessageId,
			listAllEvents,
			deleteEvent,
		} as const;
	}),
);
