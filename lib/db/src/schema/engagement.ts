import { pgTable, text, boolean, serial, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const socialPlatformEnum = pgEnum("social_platform", ["twitter", "tiktok", "instagram", "youtube", "twitch"]);

export const reactionRolesTable = pgTable("reaction_roles", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  emoji: text("emoji").notNull(),
  roleId: text("role_id").notNull(),
  roleName: text("role_name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const welcomeSettingsTable = pgTable("welcome_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  welcomeEnabled: boolean("welcome_enabled").notNull().default(false),
  welcomeChannelId: text("welcome_channel_id"),
  welcomeMessage: text("welcome_message").notNull().default("Welcome to the server, {user}!"),
  welcomeEmbed: boolean("welcome_embed").notNull().default(false),
  goodbyeEnabled: boolean("goodbye_enabled").notNull().default(false),
  goodbyeChannelId: text("goodbye_channel_id"),
  goodbyeMessage: text("goodbye_message").notNull().default("Goodbye, {user}. We'll miss you!"),
  dmWelcome: boolean("dm_welcome").notNull().default(false),
  dmMessage: text("dm_message").notNull().default("Welcome to {server}! Enjoy your stay."),
  boosterChannelId: text("booster_channel_id"),
  boosterMessage: text("booster_message").notNull().default("🎉 Thank you {user} for boosting **{server}**!"),
  eventLogChannelId: text("event_log_channel_id"),
  vcLogChannelId: text("vc_log_channel_id"),
  // New fields
  autoRoleId: text("auto_role_id"),
  pingOnJoinChannelId: text("ping_on_join_channel_id"),
  vanityCode: text("vanity_code"),
  vanityRoleId: text("vanity_role_id"),
  guildPrefix: text("guild_prefix"),
  vcMasterJoinChannelId: text("vc_master_join_channel_id"),
  vcMasterCategoryId: text("vc_master_category_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const boosterRolesTable = pgTable("booster_roles", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  roleId: text("role_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const guildBoosterRoleConfigTable = pgTable("guild_booster_role_config", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  baseRoleId: text("base_role_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const socialAlertsTable = pgTable("social_alerts", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  platform: socialPlatformEnum("platform").notNull(),
  accountHandle: text("account_handle").notNull(),
  channelId: text("channel_id").notNull(),
  message: text("message").notNull().default("{account} just posted! Check it out: {url}"),
  enabled: boolean("enabled").notNull().default(true),
  lastChecked: timestamp("last_checked"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertReactionRoleSchema = createInsertSchema(reactionRolesTable).omit({ id: true, createdAt: true });
export const insertWelcomeSettingsSchema = createInsertSchema(welcomeSettingsTable).omit({ id: true, updatedAt: true });
export const insertSocialAlertSchema = createInsertSchema(socialAlertsTable).omit({ id: true, createdAt: true });

export type ReactionRole = typeof reactionRolesTable.$inferSelect;
export type InsertReactionRole = z.infer<typeof insertReactionRoleSchema>;
export type WelcomeSettings = typeof welcomeSettingsTable.$inferSelect;
export type InsertWelcomeSettings = z.infer<typeof insertWelcomeSettingsSchema>;
export type SocialAlert = typeof socialAlertsTable.$inferSelect;
export type InsertSocialAlert = z.infer<typeof insertSocialAlertSchema>;
export type BoosterRole = typeof boosterRolesTable.$inferSelect;
