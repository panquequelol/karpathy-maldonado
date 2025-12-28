import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const events = sqliteTable("events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	slug: text("slug").notNull().unique(),
	title: text("title").notNull(),
	description: text("description").notNull(),
	organizer: text("organizer").notNull(),
	startAt: text("start_at").notNull(),
	endAt: text("end_at"),
	locationType: text("location_type").notNull(),
	fullAddress: text("full_address"),
	messageBody: text("message_body").notNull(),
	whatsappMessageId: text("whatsapp_message_id").notNull().unique(),
	whatsappGroupJid: text("whatsapp_group_jid").notNull(),
	whatsappSenderJid: text("whatsapp_sender_jid").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export type InsertEvent = typeof events.$inferInsert;
export type SelectEvent = typeof events.$inferSelect;
