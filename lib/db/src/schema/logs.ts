import { pgTable, text, serial, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const logTypeEnum = pgEnum("log_type", [
  "antinuke_triggered",
  "antiraid_triggered",
  "automod_action",
  "member_ban",
  "member_kick",
  "member_warn",
  "member_jail",
  "member_unjail",
  "settings_change",
  "bot_action",
]);

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  type: logTypeEnum("type").notNull(),
  executorId: text("executor_id"),
  executorName: text("executor_name"),
  targetId: text("target_id"),
  targetName: text("target_name"),
  reason: text("reason"),
  details: text("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, createdAt: true });

export type AuditLog = typeof auditLogsTable.$inferSelect;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
