import "dotenv/config";
import type { Config } from "drizzle-kit";

const url = process.env.TURSO_DB_URL ?? "file:./local.db";
const isLocal = url.startsWith("file:");

export default {
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dialect: isLocal ? "sqlite" : ("turso" as const),
	dbCredentials: isLocal
		? { url }
		: {
				url,
				authToken: process.env.TURSO_DB_AUTH_TOKEN ?? "",
			},
} satisfies Config;
