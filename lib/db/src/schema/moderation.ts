import { pgTable, text, integer, boolean, serial, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const spamActionEnum = pgEnum("spam_action", ["delete", "warn", "mute", "kick", "ban"]);

export const automodSettingsTable = pgTable("automod_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  filterInvites: boolean("filter_invites").notNull().default(false),
  filterLinks: boolean("filter_links").notNull().default(false),
  filterSpam: boolean("filter_spam").notNull().default(false),
  filterCaps: boolean("filter_caps").notNull().default(false),
  capsThreshold: integer("caps_threshold").notNull().default(70),
  filterMentionSpam: boolean("filter_mention_spam").notNull().default(false),
  maxMentions: integer("max_mentions").notNull().default(5),
  filterWords: boolean("filter_words").notNull().default(false),
  bannedWords: text("banned_words").array().notNull().default([]),
  spamAction: spamActionEnum("spam_action").notNull().default("delete"),
  logChannelId: text("log_channel_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const jailSettingsTable = pgTable("jail_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  jailChannelId: text("jail_channel_id"),
  jailRoleId: text("jail_role_id"),
  logChannelId: text("log_channel_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAutomodSettingsSchema = createInsertSchema(automodSettingsTable).omit({ id: true, updatedAt: true });
export const insertJailSettingsSchema = createInsertSchema(jailSettingsTable).omit({ id: true, updatedAt: true });

export type AutomodSettings = typeof automodSettingsTable.$inferSelect;
export type InsertAutomodSettings = z.infer<typeof insertAutomodSettingsSchema>;
export type JailSettings = typeof jailSettingsTable.$inferSelect;
export type InsertJailSettings = z.infer<typeof insertJailSettingsSchema>;
