import { Effect, Layer, Data, Context, Config, Secret, Option } from "effect";
import { drizzle } from "drizzle-orm/d1";
import { createClient } from "@libsql/client";

export type DatabaseConfig = {
	readonly url: string;
	readonly authToken: Option.Option<string>;
};

export class DatabaseConfigError extends Data.TaggedError("DatabaseConfigError")<{
	readonly reason: string;
}> {
	override readonly message = "Database configuration error";
}

export const DatabaseConfig = Context.GenericTag<DatabaseConfig>("DatabaseConfig");

export const loadDatabaseConfig = () =>
	Effect.gen(function* () {
		const url = yield* Config.string("TURSO_DB_URL").pipe(
			Config.withDescription("Database URL (use file:./local.db for local testing)"),
		);

		const authTokenOption = yield* Config.option(
			Config.secret("TURSO_DB_AUTH_TOKEN").pipe(
				Config.withDescription("Database auth token (leave empty for local file)"),
			),
		);

		const authToken = Option.map(authTokenOption, Secret.value);

		return { url, authToken } as const;
	}).pipe(
		Effect.mapError((error) => new DatabaseConfigError({ reason: String(error) })),
	);

export type Database = ReturnType<typeof drizzle>;

export const createDatabase = (config: DatabaseConfig): Database => {
	const clientConfig: { url: string; authToken?: string } = {
		url: config.url,
	};

	if (Option.isSome(config.authToken)) {
		clientConfig.authToken = config.authToken.value;
	}

	const client = createClient(clientConfig);
	return drizzle(client);
};

export const Database = Context.GenericTag<Database>("Database");

export const DatabaseLive = Layer.effect(
	Database,
	Effect.map(loadDatabaseConfig(), createDatabase),
);
