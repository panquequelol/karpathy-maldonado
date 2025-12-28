import { Data, Effect, Ref, Config } from "effect";

type GroupJid = `${string}@g.us`;

type AppMode = "monitor" | "discovery";

type MonitorConfig = {
	readonly mode: "monitor";
	readonly allowedGroupJids: ReadonlyArray<GroupJid>;
};

type DiscoveryConfig = {
	readonly mode: "discovery";
};

type Config = MonitorConfig | DiscoveryConfig;
type ConfigRef = Ref.Ref<Config>;

class ConfigError extends Data.TaggedError("ConfigError")<{
	readonly reason: "InvalidJidFormat";
	readonly value?: string;
	readonly context?: string;
}> {
	override get message(): string {
		const parts = [`ConfigError: ${this.reason}`];
		if (this.context) parts.push(this.context);
		if (this.value) parts.push(`got: "${this.value}"`);
		return parts.join(" - ");
	}
}

const parseAllowedGroups = (envValue: string) =>
	Effect.gen(function* () {
		const jids = envValue.split(",").map((jid) => jid.trim()).filter((jid) => jid.length > 0);

		if (jids.length === 0) {
			return [] as ReadonlyArray<GroupJid>;
		}

		const validJids = jids.filter((jid): jid is GroupJid => jid.endsWith("@g.us"));

		if (validJids.length === 0) {
			return yield* Effect.fail(
				new ConfigError({
					reason: "InvalidJidFormat",
					value: envValue,
					context: `No valid group JIDs found. Group JIDs must end with '@g.us'.`,
				}),
			);
		}

		if (validJids.length !== jids.length) {
			const invalid = jids.filter((jid) => !jid.endsWith("@g.us"));
			yield* Effect.logWarning(`Invalid group JIDs ignored: ${invalid.join(", ")}`);
		}

		return validJids;
	});

const loadConfig = () =>
	Effect.gen(function* () {
		const allowedGroupsEnv = yield* Config.string("WHATSAPP_ALLOWED_GROUPS").pipe(
			Config.withDescription("Comma-separated list of WhatsApp group JIDs to monitor"),
			Config.withDefault(""),
		).pipe(
			Effect.mapError((error) =>
				new ConfigError({
					reason: "InvalidJidFormat",
					value: String(error),
					context: "Failed to parse WHATSAPP_ALLOWED_GROUPS environment variable",
				}),
			),
		);

		if (allowedGroupsEnv === "") {
			yield* Effect.logInfo("No groups configured - entering discovery mode");
			return { mode: "discovery" } as const;
		}

		const allowedGroupJids = yield* parseAllowedGroups(allowedGroupsEnv);

		if (allowedGroupJids.length === 0) {
			yield* Effect.logInfo("No valid groups configured - entering discovery mode");
			return { mode: "discovery" } as const;
		}

		return {
			mode: "monitor",
			allowedGroupJids,
		} as const;
	});

const makeConfigRef = () =>
	Effect.map(loadConfig(), (config) => Ref.unsafeMake(config));

const isGroupAllowed = (config: Config, groupJid: GroupJid): boolean =>
	config.mode === "monitor" && config.allowedGroupJids.includes(groupJid);

export type { AppMode, Config, ConfigRef, DiscoveryConfig, GroupJid, MonitorConfig };
export { ConfigError, isGroupAllowed, loadConfig, makeConfigRef, parseAllowedGroups, Ref };
