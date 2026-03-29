import { pgTable, text, integer, boolean, serial, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const antinukeActionEnum = pgEnum("antinuke_action", ["ban", "kick", "strip_roles", "timeout"]);

export const antinukeSettingsTable = pgTable("antinuke_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  maxChannelDeletes: integer("max_channel_deletes").notNull().default(3),
  maxBans: integer("max_bans").notNull().default(3),
  maxKicks: integer("max_kicks").notNull().default(5),
  maxRoleDeletes: integer("max_role_deletes").notNull().default(3),
  maxWebhookCreates: integer("max_webhook_creates").notNull().default(5),
  intervalSeconds: integer("interval_seconds").notNull().default(10),
  action: antinukeActionEnum("action").notNull().default("strip_roles"),
  logChannelId: text("log_channel_id"),
  dmOwner: boolean("dm_owner").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const antinukeWhitelistTable = pgTable("antinuke_whitelist", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  targetId: text("target_id").notNull(),
  targetType: text("target_type").notNull(),
  targetName: text("target_name").notNull(),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const insertAntinukeSettingsSchema = createInsertSchema(antinukeSettingsTable).omit({ id: true, updatedAt: true });
export const insertAntinukeWhitelistSchema = createInsertSchema(antinukeWhitelistTable).omit({ id: true, addedAt: true });

export type AntinukeSettings = typeof antinukeSettingsTable.$inferSelect;
export type InsertAntinukeSettings = z.infer<typeof insertAntinukeSettingsSchema>;
export type AntinukeWhitelist = typeof antinukeWhitelistTable.$inferSelect;
export type InsertAntinukeWhitelist = z.infer<typeof insertAntinukeWhitelistSchema>;
