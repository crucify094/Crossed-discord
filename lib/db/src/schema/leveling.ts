import { pgTable, text, integer, boolean, serial, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const levelingSettingsTable = pgTable("leveling_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  xpPerMessage: integer("xp_per_message").notNull().default(15),
  xpCooldownSeconds: integer("xp_cooldown_seconds").notNull().default(60),
  levelUpMessage: text("level_up_message").notNull().default("GG {user}, you just reached level {level}!"),
  levelUpChannelId: text("level_up_channel_id"),
  ignoredChannels: text("ignored_channels").array().notNull().default([]),
  ignoredRoles: text("ignored_roles").array().notNull().default([]),
  stackRoles: boolean("stack_roles").notNull().default(false),
  levelRoles: jsonb("level_roles").notNull().default([]),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertLevelingSettingsSchema = createInsertSchema(levelingSettingsTable).omit({ id: true, updatedAt: true });

export type LevelingSettings = typeof levelingSettingsTable.$inferSelect;
export type InsertLevelingSettings = z.infer<typeof insertLevelingSettingsSchema>;
