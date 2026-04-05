import { pgTable, text, integer, serial, timestamp, unique } from "drizzle-orm/pg-core";

export const serverSnapshotTable = pgTable("server_snapshots", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  slot: integer("slot").notNull().default(0),
  data: text("data").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("server_snapshots_guild_slot_unique").on(t.guildId, t.slot),
]);

export type ServerSnapshot = typeof serverSnapshotTable.$inferSelect;
