import {
  Client,
  Guild,
  ChannelType,
  AuditLogEvent,
  EmbedBuilder,
  GuildChannel,
  CategoryChannel,
  type TextChannel,
} from "discord.js";
import { logger } from "./logger";
import { db } from "@workspace/db";
import { serverSnapshotTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SavedOverwrite { id: string; type: number; allow: string; deny: string; }

interface SavedChannel {
  id: string; name: string; type: number; position: number;
  parentName: string | null; topic: string | null; nsfw: boolean;
  bitrate?: number; userLimit?: number;
  permissionOverwrites: SavedOverwrite[];
}

interface SavedCategory {
  id: string; name: string; position: number;
  permissionOverwrites: SavedOverwrite[];
}

interface ServerSnapshot { categories: SavedCategory[]; channels: SavedChannel[]; }

const THREAD_TYPES = new Set([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

// ── Snapshot capture ───────────────────────────────────────────────────────────

export async function captureServerSnapshot(guild: Guild): Promise<ServerSnapshot> {
  await guild.channels.fetch();
  const categories: SavedCategory[] = [];
  const channels: SavedChannel[] = [];

  for (const [, ch] of guild.channels.cache) {
    if (THREAD_TYPES.has(ch.type as any)) continue;
    try {
      if (ch.type === ChannelType.GuildCategory) {
        const cat = ch as CategoryChannel;
        categories.push({
          id: cat.id,
          name: cat.name,
          position: cat.rawPosition,
          permissionOverwrites: cat.permissionOverwrites.cache.map(pw => ({
            id: pw.id, type: pw.type,
            allow: pw.allow.bitfield.toString(),
            deny: pw.deny.bitfield.toString(),
          })),
        });
      } else {
        const c = ch as GuildChannel;
        if (!c.permissionOverwrites) continue;
        channels.push({
          id: c.id,
          name: c.name,
          type: c.type,
          position: c.rawPosition,
          parentName: c.parent?.name ?? null,
          topic: (c as any).topic ?? null,
          nsfw: (c as any).nsfw ?? false,
          bitrate: (c as any).bitrate ?? undefined,
          userLimit: (c as any).userLimit ?? undefined,
          permissionOverwrites: c.permissionOverwrites.cache.map(pw => ({
            id: pw.id, type: pw.type,
            allow: pw.allow.bitfield.toString(),
            deny: pw.deny.bitfield.toString(),
          })),
        });
      }
    } catch (err) {
      logger.warn({ err, channelId: ch.id, tag: "autoRestore" }, "Skipped channel during snapshot capture");
    }
  }

  categories.sort((a, b) => a.position - b.position);
  channels.sort((a, b) => a.position - b.position);
  return { categories, channels };
}

// ── Snapshot save ──────────────────────────────────────────────────────────────

export async function saveSnapshot(guild: Guild): Promise<void> {
  try {
    const snapshot = await captureServerSnapshot(guild);
    const data = JSON.stringify(snapshot);
    await db.insert(serverSnapshotTable)
      .values({ guildId: guild.id, slot: 0, data })
      .onConflictDoUpdate({
        target: [serverSnapshotTable.guildId, serverSnapshotTable.slot],
        set: { data, createdAt: sql`now()` },
      });
    logger.info({ guildId: guild.id, tag: "autoRestore" }, "Server snapshot saved");
  } catch (err) {
    logger.error({ err, guildId: guild.id, tag: "autoRestore" }, "Failed to save snapshot");
  }
}

// ── Snapshot apply (add missing only, never duplicate) ─────────────────────────

async function applySnapshot(
  guild: Guild,
  snapshot: ServerSnapshot,
  applyPermissions: boolean,
): Promise<{ created: number; skipped: number }> {
  await guild.channels.fetch();
  let created = 0;
  let skipped = 0;

  const categoryMap = new Map<string, string>();

  for (const cat of snapshot.categories) {
    const existing = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === cat.name.toLowerCase()
    );
    if (existing) { categoryMap.set(cat.name, existing.id); skipped++; continue; }

    const overwrites = applyPermissions ? cat.permissionOverwrites.map(pw => ({
      id: pw.id, type: pw.type as 0 | 1,
      allow: BigInt(pw.allow), deny: BigInt(pw.deny),
    })) : [];

    try {
      const newCat = await guild.channels.create({
        name: cat.name, type: ChannelType.GuildCategory,
        position: cat.position, permissionOverwrites: overwrites,
      });
      categoryMap.set(cat.name, newCat.id);
      created++;
    } catch { skipped++; }
  }

  for (const ch of snapshot.channels) {
    const existing = guild.channels.cache.find(
      c => c.type !== ChannelType.GuildCategory && c.name.toLowerCase() === ch.name.toLowerCase()
    );
    if (existing) { skipped++; continue; }

    const parentId = ch.parentName ? (categoryMap.get(ch.parentName) ?? undefined) : undefined;
    const overwrites = applyPermissions ? ch.permissionOverwrites.map(pw => ({
      id: pw.id, type: pw.type as 0 | 1,
      allow: BigInt(pw.allow), deny: BigInt(pw.deny),
    })) : [];

    try {
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
        await guild.channels.create({
          name: ch.name, type: ch.type as ChannelType.GuildText | ChannelType.GuildAnnouncement,
          parent: parentId, position: ch.position,
          topic: ch.topic ?? undefined, nsfw: ch.nsfw, permissionOverwrites: overwrites,
        });
      } else if (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) {
        await guild.channels.create({
          name: ch.name, type: ch.type as ChannelType.GuildVoice | ChannelType.GuildStageVoice,
          parent: parentId, position: ch.position,
          bitrate: ch.bitrate, userLimit: ch.userLimit, permissionOverwrites: overwrites,
        });
      } else {
        await guild.channels.create({
          name: ch.name, type: ChannelType.GuildText,
          parent: parentId, position: ch.position, permissionOverwrites: overwrites,
        });
      }
      created++;
    } catch { skipped++; }
  }

  return { created, skipped };
}

// ── Debounce auto-save on channel changes ──────────────────────────────────────

const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAutoSave(guild: Guild, delayMs = 30_000) {
  const existing = autoSaveTimers.get(guild.id);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    autoSaveTimers.delete(guild.id);
    saveSnapshot(guild);
  }, delayMs);
  autoSaveTimers.set(guild.id, t);
}

// ── Nuke detection tracking ────────────────────────────────────────────────────

const NUKE_THRESHOLD = 3;
const NUKE_WINDOW_MS = 60_000;

const deletionTracker = new Map<string, { timestamps: number[]; restoring: boolean }>();

// ── Auto-restore execution ─────────────────────────────────────────────────────

async function triggerAutoRestore(guild: Guild, client: Client): Promise<void> {
  const [row] = await db.select().from(serverSnapshotTable)
    .where(and(eq(serverSnapshotTable.guildId, guild.id), eq(serverSnapshotTable.slot, 0)))
    .limit(1);

  if (!row) {
    logger.warn({ guildId: guild.id, tag: "autoRestore" }, "Nuke detected but no snapshot exists — nothing to restore");
    return;
  }

  // Identify nuker from recent audit logs
  const nukerIds = new Set<string>();
  try {
    const cutoff = Date.now() - NUKE_WINDOW_MS * 2;
    const counts = new Map<string, number>();

    const chanLogs = await guild.fetchAuditLogs({ limit: 50, type: AuditLogEvent.ChannelDelete });
    for (const entry of chanLogs.entries.values()) {
      if (entry.createdTimestamp < cutoff) continue;
      if (!entry.executorId || entry.executorId === client.user?.id) continue;
      counts.set(entry.executorId, (counts.get(entry.executorId) ?? 0) + 1);
    }

    const roleLogs = await guild.fetchAuditLogs({ limit: 50, type: AuditLogEvent.RoleDelete });
    for (const entry of roleLogs.entries.values()) {
      if (entry.createdTimestamp < cutoff) continue;
      if (!entry.executorId || entry.executorId === client.user?.id) continue;
      counts.set(entry.executorId, (counts.get(entry.executorId) ?? 0) + 1);
    }

    for (const [id, count] of counts) {
      if (count >= 2 && id !== guild.ownerId) nukerIds.add(id);
    }
  } catch (err) {
    logger.warn({ err, tag: "autoRestore" }, "Failed to fetch audit logs during restore");
  }

  // Ban nukers and purge their recent messages
  const bannedNames: string[] = [];
  for (const nukerId of nukerIds) {
    try {
      const nukerUser = await client.users.fetch(nukerId).catch(() => null);
      const nukerMember = await guild.members.fetch(nukerId).catch(() => null);

      for (const [, ch] of guild.channels.cache) {
        if (!ch.isTextBased() || ch.type === ChannelType.GuildCategory) continue;
        try {
          const msgs = await (ch as TextChannel).messages.fetch({ limit: 100 });
          const toDelete = msgs.filter(m => m.author.id === nukerId);
          if (toDelete.size > 0) await (ch as TextChannel).bulkDelete(toDelete).catch(() => null);
        } catch {}
      }

      if (nukerMember) {
        await nukerMember.ban({ reason: "Auto-restore: mass channel deletion detected" }).catch(() => null);
      } else {
        await guild.bans.create(nukerId, { reason: "Auto-restore: mass channel deletion detected" }).catch(() => null);
      }

      bannedNames.push(nukerUser?.tag ?? nukerId);
    } catch {}
  }

  // Rebuild missing channels and categories
  let created = 0;
  let skipped = 0;
  try {
    const snapshot: ServerSnapshot = JSON.parse(row.data);
    const result = await applySnapshot(guild, snapshot, true);
    created = result.created;
    skipped = result.skipped;
  } catch (err) {
    logger.error({ err, guildId: guild.id, tag: "autoRestore" }, "Failed to apply snapshot");
    return;
  }

  // Notify in system channel or first available text channel
  try {
    const notifyChannel =
      (guild.systemChannelId ? guild.channels.cache.get(guild.systemChannelId) : null) ??
      guild.channels.cache.find(c => c.isTextBased() && c.type !== ChannelType.GuildCategory);

    if (notifyChannel?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle("🛡️  Server Auto-Restored")
        .setDescription(
          `A nuke attempt was detected and automatically reversed.\n\n` +
          `✅ **${created}** missing channel${created !== 1 ? "s" : ""}/categor${created !== 1 ? "ies" : "y"} rebuilt.\n` +
          `⏭️ **${skipped}** already existed — no duplicates created.\n` +
          (bannedNames.length > 0
            ? `🔨 **Banned:** ${bannedNames.join(", ")}`
            : `⚠️ No external nuker detected in audit logs.`)
        )
        .setTimestamp();
      await (notifyChannel as TextChannel).send({ embeds: [embed] });
    }
  } catch {}

  logger.info({ guildId: guild.id, created, skipped, banned: bannedNames, tag: "autoRestore" }, "Auto-restore complete");

  // Re-save the snapshot to reflect current state
  await saveSnapshot(guild);
}

// ── Register all handlers ──────────────────────────────────────────────────────

export function registerAutoRestoreHandlers(client: Client): void {

  // Save a snapshot for all currently joined guilds on startup
  for (const [, guild] of client.guilds.cache) {
    saveSnapshot(guild).catch(() => null);
  }

  // Save snapshot when bot joins a new server
  client.on("guildCreate", (guild) => {
    saveSnapshot(guild).catch(() => null);
  });

  // Debounced re-save whenever channels are created or updated
  client.on("channelCreate", (channel) => {
    if (!(channel as GuildChannel).guild) return;
    scheduleAutoSave((channel as GuildChannel).guild);
  });

  client.on("channelUpdate", (_old, channel) => {
    if (!(channel as GuildChannel).guild) return;
    scheduleAutoSave((channel as GuildChannel).guild);
  });

  // Nuke detection: watch for mass channel deletions
  client.on("channelDelete", (channel) => {
    const guild = (channel as GuildChannel).guild;
    if (!guild) return;

    const now = Date.now();
    let tracker = deletionTracker.get(guild.id);
    if (!tracker) {
      tracker = { timestamps: [], restoring: false };
      deletionTracker.set(guild.id, tracker);
    }

    // Drop stale entries
    tracker.timestamps = tracker.timestamps.filter(t => now - t < NUKE_WINDOW_MS);
    tracker.timestamps.push(now);

    if (tracker.restoring) return;

    if (tracker.timestamps.length >= NUKE_THRESHOLD) {
      tracker.restoring = true;
      tracker.timestamps = [];
      logger.warn({ guildId: guild.id, tag: "autoRestore" }, "Nuke detected — starting auto-restore");

      triggerAutoRestore(guild, client)
        .catch(err => logger.error({ err, guildId: guild.id, tag: "autoRestore" }, "Auto-restore failed"))
        .finally(() => {
          const t = deletionTracker.get(guild.id);
          if (t) t.restoring = false;
        });
    }
  });

  // Refresh snapshots every 30 minutes to stay current
  setInterval(() => {
    for (const [, guild] of client.guilds.cache) {
      saveSnapshot(guild).catch(() => null);
    }
  }, 30 * 60 * 1000);

  logger.info({ tag: "autoRestore" }, "Auto-restore handlers registered");
}
