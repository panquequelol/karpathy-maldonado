import type { WASocket } from "@whiskeysockets/baileys";
import type { GroupJid } from "./types";

interface GroupMetadata {
	id: GroupJid;
	subject: string;
	participantCount: number;
}

const listAllGroups = async (socket: WASocket): Promise<ReadonlyArray<GroupMetadata>> => {
	const groups = await socket.groupFetchAllParticipating();

	return Object.values(groups).map((group) => ({
		id: group.id as GroupJid,
		subject: group.subject ?? "Unnamed Group",
		participantCount: group.participants.length,
	}));
};

const logGroupsForDiscovery = (groups: ReadonlyArray<GroupMetadata>): void => {
	console.log("\n📋 Your WhatsApp Groups:");
	console.log("─".repeat(60));
	console.log("Copy the JID (looks like 1234567890@g.us) into your .env file");
	console.log("─".repeat(60));

	for (const group of groups) {
		console.log(`\n📁 ${group.subject}`);
		console.log(`   JID: ${group.id}`);
		console.log(`   Members: ${group.participantCount}`);
	}

	console.log("\n" + "─".repeat(60));
	console.log("💡 Add to .env: WHATSAPP_ALLOWED_GROUPS=<JID1>,<JID2>,...");
	console.log("─".repeat(60) + "\n");
};

export type { GroupMetadata };
export { listAllGroups, logGroupsForDiscovery };
