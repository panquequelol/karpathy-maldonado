import { Data, Effect } from "effect";

const CONFIG_ENV_KEYS = {
	WHATSAPP_ALLOWED_GROUPS: "WHATSAPP_ALLOWED_GROUPS",
	WHATSAPP_LIST_GROUPS_ON_START: "WHATSAPP_LIST_GROUPS_ON_START",
} as const;

type GroupJid = `${string}@g.us`;

interface Config {
	readonly allowedGroupJids: ReadonlyArray<GroupJid>;
	readonly listGroupsOnStart: boolean;
}

class ConfigError extends Data.TaggedError("ConfigError")<{
	readonly reason:
		| "MissingAllowedGroups"
		| "EmptyAllowedGroups"
		| "InvalidGroupJid"
		| "InvalidJidFormat";
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

const parseAllowedGroups = (
	envValue: string | undefined,
): Effect.Effect<ReadonlyArray<GroupJid>, ConfigError> =>
	Effect.gen(function* () {
		if (envValue === undefined || envValue === "") {
			return yield* Effect.fail(
				new ConfigError({
					reason: "MissingAllowedGroups",
					context: "WHATSAPP_ALLOWED_GROUPS is required. Set WHATSAPP_LIST_GROUPS_ON_START=true to discover group JIDs.",
				}),
			);
		}

		const jids = envValue.split(",").map((jid) => jid.trim()).filter((jid) => jid.length > 0);

		if (jids.length === 0) {
			return yield* Effect.fail(
				new ConfigError({
					reason: "EmptyAllowedGroups",
					context: "WHATSAPP_ALLOWED_GROUPS cannot be empty.",
				}),
			);
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
			yield* Effect.logWarning(`⚠️  Invalid group JIDs will be ignored: ${invalid.join(", ")}`);
		}

		return validJids;
	});

const parseListGroupsOnStart = (envValue: string | undefined): boolean => {
	if (envValue === undefined || envValue === "") return false;

	const normalized = envValue.toLowerCase().trim();
	return normalized === "true" || normalized === "1" || normalized === "yes";
};

const loadConfig = (): Effect.Effect<Config, ConfigError> =>
	Effect.gen(function* () {
		const allowedGroupsEnv = process.env[CONFIG_ENV_KEYS.WHATSAPP_ALLOWED_GROUPS] as string | undefined;
		const listGroupsEnv = process.env[CONFIG_ENV_KEYS.WHATSAPP_LIST_GROUPS_ON_START] as string | undefined;

		const allowedGroupJids = yield* parseAllowedGroups(allowedGroupsEnv);

		return {
			allowedGroupJids,
			listGroupsOnStart: parseListGroupsOnStart(listGroupsEnv),
		} as const;
	});

const isGroupAllowed = (config: Config, groupJid: GroupJid): boolean =>
	config.allowedGroupJids.includes(groupJid);

export type { Config };
export { ConfigError, CONFIG_ENV_KEYS, isGroupAllowed, loadConfig, parseAllowedGroups, parseListGroupsOnStart };
