import type { WASocket } from "@whiskeysockets/baileys";
import { Effect } from "effect";
import type { GroupJid } from "./types";

interface GroupMetadata {
	readonly id: GroupJid;
	readonly subject: string;
	readonly participantCount: number;
}

const listAllGroups = (socket: WASocket): Effect.Effect<ReadonlyArray<GroupMetadata>, Error> =>
	Effect.tryPromise({
		try: () => socket.groupFetchAllParticipating(),
		catch: (error) => new Error(`Failed to fetch groups: ${error}`),
	}).pipe(
		Effect.map((groups) =>
			Object.values(groups).map((group) => ({
				id: group.id as GroupJid,
				subject: group.subject ?? "Unnamed Group",
				participantCount: group.participants.length,
			})),
		),
	);

const logGroupsForDiscovery = (groups: ReadonlyArray<GroupMetadata>): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* Effect.log("\n== Tus grupos de WhatsApp:");
		yield* Effect.log("─".repeat(60));
		yield* Effect.log("Copia el JID (se ve como 1234567890@g.us) en tu archivo .env");
		yield* Effect.log("─".repeat(60));

		for (const group of groups) {
			yield* Effect.log(`\n> ${group.subject}`);
			yield* Effect.log(`   JID: ${group.id}`);
			yield* Effect.log(`   Miembros: ${group.participantCount}`);
		}

		yield* Effect.log("\n" + "─".repeat(60));
		yield* Effect.log("INFO: Agrega a .env: WHATSAPP_ALLOWED_GROUPS=<JID1>,<JID2>,...");
		yield* Effect.log("─".repeat(60) + "\n");
	});

export type { GroupMetadata };
export { listAllGroups, logGroupsForDiscovery };
