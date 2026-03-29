import { Client, EmbedBuilder, AuditLogEvent } from "discord.js";
import { logger } from "./logger";

// ── Editable Config ───────────────────────────────────────────────────────────

export const autoModConfig = {
  enabled: true,
  pingThreshold: 4,
  pingWindowMs: 30_000,
  channelThreshold: 3,
  channelWindowMs: 10_000,
  massbanThreshold: 3,
  massbanWindowMs: 10_000,
  masskickThreshold: 5,
  masskickWindowMs: 10_000,
  massroleThreshold: 5,
  massroleWindowMs: 10_000,
};

// ── Trackers ──────────────────────────────────────────────────────────────────

const pingTracker = new Map<string, number[]>();
const channelTracker = new Map<string, number[]>();
const banTracker = new Map<string, number[]>();
const kickTracker = new Map<string, number[]>();
const roleTracker = new Map<string, number[]>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function track(map: Map<string, number[]>, key: string, windowMs: number): number {
  const now = Date.now();
  const times = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  times.push(now);
  map.set(key, times);
  return times.length;
}

function banEmbed(tag: string, reason: string) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🔨  Auto-Mod: Automatic Ban")
    .setDescription(`**${tag}** was banned automatically.`)
    .addFields({ name: "Reason", value: reason })
    .setTimestamp();
}

// ── Handler ───────────────────────────────────────────────────────────────────

export function registerAutoModHandlers(client: Client): void {

  // ── Ping Spam ──────────────────────────────────────────────────────────────
  client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;
    if (!autoModConfig.enabled) return;

    const mentionCount =
      message.mentions.users.size +
      message.mentions.roles.size +
      (message.mentions.everyone ? 1 : 0);

    if (mentionCount === 0) return;

    const key = `${message.guild.id}:${message.author.id}`;
    const count = track(pingTracker, key, autoModConfig.pingWindowMs);

    if (count >= autoModConfig.pingThreshold) {
      pingTracker.delete(key);
      try {
        const member = message.member;
        if (!member?.bannable) return;
        const reason = `Auto-Mod: Ping spam — ${autoModConfig.pingThreshold}+ mentions in ${autoModConfig.pingWindowMs / 1000}s`;
        await member.ban({ reason });
        await message.channel.send({ embeds: [banEmbed(message.author.tag, reason)] }).catch(() => null);
        logger.info({ tag: "automod", user: message.author.tag, guild: message.guild.id }, "Ping spammer banned");
      } catch (err) {
        logger.error({ err, tag: "automod" }, "Failed to ban ping spammer");
      }
    }
  });

  // ── Channel Creation Spam ──────────────────────────────────────────────────
  client.on("channelCreate", async (channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    if (!autoModConfig.enabled) return;
    const guild = channel.guild;
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 1 });
      const entry = logs.entries.first();
      if (!entry?.executor) return;
      if (Date.now() - entry.createdTimestamp > 5_000) return;
      const executor = entry.executor;
      const key = `${guild.id}:${executor.id}`;
      const count = track(channelTracker, key, autoModConfig.channelWindowMs);
      if (count >= autoModConfig.channelThreshold) {
        channelTracker.delete(key);
        const reason = `Auto-Mod: Channel spam — ${autoModConfig.channelThreshold}+ channels created in ${autoModConfig.channelWindowMs / 1000}s`;
        await guild.bans.create(executor.id, { reason });
        const embed = banEmbed(executor.tag ?? executor.username, reason);
        const target = guild.systemChannel ?? guild.channels.cache.find((c) => c.isTextBased() && "send" in c) as any;
        if (target) await target.send({ embeds: [embed] }).catch(() => null);
        logger.info({ tag: "automod", user: executor.tag, guild: guild.id }, "Channel spammer banned");
      }
    } catch (err) {
      logger.error({ err, tag: "automod" }, "Channel-create automod failed");
    }
  });

  // ── Mass Ban Detection ─────────────────────────────────────────────────────
  client.on("guildBanAdd", async (ban) => {
    if (!autoModConfig.enabled) return;
    const guild = ban.guild;
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 });
      const entry = logs.entries.first();
      if (!entry?.executor) return;
      if (Date.now() - entry.createdTimestamp > 5_000) return;
      if (entry.executor.bot) return;
      const key = `${guild.id}:${entry.executor.id}`;
      const count = track(banTracker, key, autoModConfig.massbanWindowMs);
      if (count >= autoModConfig.massbanThreshold) {
        banTracker.delete(key);
        const reason = `Auto-Mod: Mass ban — ${autoModConfig.massbanThreshold}+ bans in ${autoModConfig.massbanWindowMs / 1000}s`;
        await guild.bans.create(entry.executor.id, { reason }).catch(() => null);
        const target = guild.systemChannel ?? guild.channels.cache.find((c) => c.isTextBased() && "send" in c) as any;
        if (target) await target.send({ embeds: [banEmbed(entry.executor.tag ?? entry.executor.username, reason)] }).catch(() => null);
        logger.info({ tag: "automod", user: entry.executor.tag, guild: guild.id }, "Mass banner banned");
      }
    } catch (err) {
      logger.error({ err, tag: "automod" }, "Mass ban detection failed");
    }
  });
}
