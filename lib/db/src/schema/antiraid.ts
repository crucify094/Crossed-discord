import { pgTable, text, integer, boolean, serial, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const antiraidActionEnum = pgEnum("antiraid_action", ["kick", "ban", "timeout", "lock"]);

export const antiraidSettingsTable = pgTable("antiraid_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  joinRateLimit: integer("join_rate_limit").notNull().default(10),
  joinRateInterval: integer("join_rate_interval").notNull().default(10),
  action: antiraidActionEnum("action").notNull().default("kick"),
  filterNoAvatar: boolean("filter_no_avatar").notNull().default(true),
  filterNewAccounts: boolean("filter_new_accounts").notNull().default(false),
  minAccountAgeDays: integer("min_account_age_days").notNull().default(7),
  lockdownEnabled: boolean("lockdown_enabled").notNull().default(false),
  logChannelId: text("log_channel_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAntiraidSettingsSchema = createInsertSchema(antiraidSettingsTable).omit({ id: true, updatedAt: true });

export type AntiraidSettings = typeof antiraidSettingsTable.$inferSelect;
export type InsertAntiraidSettings = z.infer<typeof insertAntiraidSettingsSchema>;
