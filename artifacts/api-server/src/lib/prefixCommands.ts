import {
  Client,
  Message,
  EmbedBuilder,
  PermissionFlagsBits,
  GuildMember,
  ChannelType,
  Collection,
  AuditLogEvent,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
  type TextChannel,
  type VoiceChannel,
  type GuildChannel,
  type CategoryChannel,
  type ButtonBuilder,
} from "discord.js";
import { logger } from "./logger";
import { db } from "@workspace/db";
import {
  welcomeSettingsTable,
  automodSettingsTable,
  antinukeWhitelistTable,
  antinukeSettingsTable,
  boosterRolesTable,
  guildBoosterRoleConfigTable,
  serverSnapshotTable,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

export const PREFIX = "-";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface CommandContext {
  message: Message;
  args: string[];
  client: Client;
}

interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  category: string;
  execute(ctx: CommandContext): Promise<void>;
}

interface Warning {
  id: number;
  reason: string;
  moderator: string;
  timestamp: number;
}

interface SnipedMsg {
  content: string;
  authorTag: string;
  authorAvatar: string | null;
  attachments: string[];
  timestamp: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// In-memory stores
// ──────────────────────────────────────────────────────────────────────────────

// warnings: `${guildId}:${userId}` → Warning[]
const warningsStore = new Map<string, Warning[]>();
let _warnId = 1;

// snipe: channelId → last deleted message
const snipeStore = new Map<string, SnipedMsg>();

// AFK: `${guildId}:${userId}` → reason
const afkStore = new Map<string, string>();

// Temp-ban timers: `${guildId}:${userId}` → NodeJS.Timeout
const tempBanTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Per-guild prefix cache: guildId → prefix
export const guildPrefixes = new Map<string, string>();

// Filter bypass: `${guildId}:${userId}` → true
export const filterBypassUsers = new Set<string>();

// Image ban: `${guildId}:${userId}` → true
export const imageBannedUsers = new Set<string>();

// Anti-spam: guildIds with anti-spam enabled
export const antiSpamEnabled = new Set<string>();
// Anti-spam tracker: `${guildId}:${userId}` → timestamps of recent messages
const antiSpamTracker = new Map<string, number[]>();

// Role restore: `${guildId}:${userId}` → roleIds[]
export const roleSaveStore = new Map<string, string[]>();

// Jail role backup: `${guildId}:${userId}` → roleIds[] (roles stripped by -jail)
const jailRoleBackupStore = new Map<string, string[]>();

// Antinuke ban tracker: `${guildId}` → map of executorId → timestamps[]
const antinukeBanTracker = new Map<string, Map<string, number[]>>();

// Booster role base: `guildId` → baseRoleId (the position anchor)
const boosterRoleBase = new Map<string, string>();

// ── Per-guild caches (avoids DB hit on every message) ─────────────────────────
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
interface CacheEntry<T> { value: T; ts: number }
const bannedWordsCache = new Map<string, CacheEntry<string[]>>();
const guildPrefixCacheTs = new Map<string, number>(); // TTL timestamps for prefix cache

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.value;
}
function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T) {
  cache.set(key, { value, ts: Date.now() });
}

const BOT_OWNER_ID = "1481484303543042069";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  error: 0xed4245,
  warning: 0xfee75c,
  info: 0x5865f2,
} as const;

function errorEmbed(desc: string) {
  return new EmbedBuilder().setColor(COLORS.error).setDescription(`❌  ${desc}`);
}
function successEmbed(desc: string) {
  return new EmbedBuilder().setColor(COLORS.success).setDescription(`✅  ${desc}`);
}
function infoEmbed(title: string) {
  return new EmbedBuilder().setColor(COLORS.primary).setTitle(title);
}
function warnEmbed(desc: string) {
  return new EmbedBuilder().setColor(COLORS.warning).setDescription(`⚠️  ${desc}`);
}

function parseDuration(str: string): number | null {
  const m = str.match(/^(\d+)(s|m|h|d|w)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  return n * (u[m[2].toLowerCase()] ?? 0);
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 604_800_000) return `${Math.floor(ms / 86_400_000)}d`;
  return `${Math.floor(ms / 604_800_000)}w`;
}

async function resolveMember(msg: Message, q: string): Promise<GuildMember | null> {
  if (!msg.guild) return null;
  const id = q.match(/\d{17,19}/)?.[0];
  if (!id) return null;
  return msg.guild.members.fetch(id).catch(() => null);
}

async function resolveUser(client: Client, q: string) {
  const id = q.match(/\d{17,19}/)?.[0];
  if (!id) return null;
  return client.users.fetch(id).catch(() => null);
}

function requirePerms(msg: Message, ...perms: bigint[]): boolean {
  if (msg.author.id === BOT_OWNER_ID) return true;
  return perms.every((p) => msg.member?.permissions.has(p));
}

// ──────────────────────────────────────────────────────────────────────────────
// Command registry
// ──────────────────────────────────────────────────────────────────────────────

const commands = new Collection<string, Command>();

function register(cmd: Command) {
  commands.set(cmd.name, cmd);
  for (const a of cmd.aliases ?? []) commands.set(a, cmd);
}

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ GENERAL COMMANDS ════════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

// ── help ─────────────────────────────────────────────────────────────────────

register({
  name: "help",
  aliases: ["h", "cmds"],
  description: "Shows all commands via an interactive select menu.",
  usage: "[command]",
  category: "General",
  async execute({ message, args, client }) {
    const unique = new Map<string, Command>();
    for (const c of commands.values()) if (!unique.has(c.name)) unique.set(c.name, c);

    // ── -help <command> ── show single command detail
    if (args[0]) {
      const target = unique.get(args[0].toLowerCase());
      if (!target) return void message.reply({ embeds: [errorEmbed(`Command \`${args[0]}\` not found.`)] });
      return void message.reply({
        embeds: [
          infoEmbed(`${PREFIX}${target.name}`)
            .setDescription(target.description)
            .addFields(
              { name: "Usage", value: `\`${PREFIX}${target.name} ${target.usage}\``, inline: true },
              { name: "Category", value: target.category, inline: true },
              ...(target.aliases?.length
                ? [{ name: "Aliases", value: target.aliases.map((a) => `\`${PREFIX}${a}\``).join(" "), inline: true }]
                : [])
            ),
        ],
      });
    }

    // ── Build category map ──
    const cats: Record<string, Command[]> = {};
    for (const c of unique.values()) (cats[c.category] ??= []).push(c);

    const catEmojis: Record<string, string> = {
      General: "🎮",
      Moderation: "🛡️",
      Leveling: "⭐",
      Giveaway: "🎉",
      Utility: "🔧",
    };

    // ── Build select menu ──
    const menu = new StringSelectMenuBuilder()
      .setCustomId("help_category")
      .setPlaceholder("Choose a category to browse commands…")
      .addOptions(
        Object.keys(cats).map((cat) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(cat)
            .setValue(cat)
            .setDescription(`${cats[cat].length} command${cats[cat].length !== 1 ? "s" : ""}`)
            .setEmoji(catEmojis[cat] ?? "📌")
        )
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    const overviewEmbed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle("📋  Command Menu")
      .setDescription(
        `Prefix: \`${PREFIX}\`  •  Use \`${PREFIX}help <command>\` for details\n\n` +
        `**${unique.size} commands** across **${Object.keys(cats).length} categories**\n` +
        `Select a category below to browse commands.`
      )
      .setFooter({ text: `Requested by ${message.author.tag}` })
      .setTimestamp();

    const reply = await message.reply({ embeds: [overviewEmbed], components: [row] });

    // ── Collect interactions ──
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.user.id === message.author.id,
      time: 60_000,
    });

    collector.on("collect", async (interaction) => {
      const selected = interaction.values[0];
      const cmds = cats[selected] ?? [];
      const list = cmds.map((c) => `\`${PREFIX}${c.name}\``).join("  ");

      const catEmbed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`${catEmojis[selected] ?? "📌"}  ${selected} Commands`)
        .setDescription(list || "No commands.")
        .setFooter({ text: `${cmds.length} command${cmds.length !== 1 ? "s" : ""}  •  Use ${PREFIX}help <command> for details` });

      await interaction.update({ embeds: [catEmbed], components: [row] });
    });

    collector.on("end", async () => {
      const disabledMenu = new StringSelectMenuBuilder()
        .setCustomId("help_category_disabled")
        .setPlaceholder("Menu expired — run -help again")
        .setDisabled(true)
        .addOptions(new StringSelectMenuOptionBuilder().setLabel("Expired").setValue("expired"));

      const disabledRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(disabledMenu);
      await reply.edit({ components: [disabledRow] }).catch(() => null);
    });
  },
});

// ── ping ─────────────────────────────────────────────────────────────────────

register({
  name: "ping",
  description: "Shows the bot's latency.",
  usage: "",
  category: "General",
  async execute({ message, client }) {
    const sent = await message.reply("Pinging…");
    const rtt = sent.createdTimestamp - message.createdTimestamp;
    await sent.edit({
      content: "",
      embeds: [
        infoEmbed("🏓  Pong!")
          .addFields(
            { name: "Roundtrip", value: `\`${rtt}ms\``, inline: true },
            { name: "WS Heartbeat", value: `\`${Math.round(client.ws.ping)}ms\``, inline: true }
          ),
      ],
    });
  },
});

// ── botinfo ───────────────────────────────────────────────────────────────────

register({
  name: "botinfo",
  aliases: ["about", "bi"],
  description: "Shows information about the bot.",
  usage: "",
  category: "General",
  async execute({ message, client }) {
    const unique = new Set([...commands.values()].map((c) => c.name));
    const uptime = process.uptime();
    const embed = infoEmbed(`🤖  ${client.user!.username}`)
      .setThumbnail(client.user!.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "Servers", value: client.guilds.cache.size.toString(), inline: true },
        { name: "Commands", value: unique.size.toString(), inline: true },
        { name: "Prefix", value: `\`${PREFIX}\``, inline: true },
        { name: "Uptime", value: fmtDuration(uptime * 1000), inline: true },
        { name: "WS Ping", value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: "Node.js", value: process.version, inline: true }
      );
    await message.reply({ embeds: [embed] });
  },
});

// ── uptime ────────────────────────────────────────────────────────────────────

register({
  name: "uptime",
  description: "Shows how long the bot has been online.",
  usage: "",
  category: "General",
  async execute({ message }) {
    await message.reply({
      embeds: [successEmbed(`Bot has been online for **${fmtDuration(process.uptime() * 1000)}**.`)],
    });
  },
});

// ── invite ────────────────────────────────────────────────────────────────────

register({
  name: "invite",
  description: "Gets the invite link for the bot.",
  usage: "",
  category: "General",
  async execute({ message, client }) {
    const link = `https://discord.com/oauth2/authorize?client_id=${client.user!.id}&permissions=8&scope=bot+applications.commands`;
    await message.reply({
      embeds: [infoEmbed("📨  Invite /Crossed").setDescription(`[Click here to invite the bot](${link})`)],
    });
  },
});

// ── userinfo ─────────────────────────────────────────────────────────────────

register({
  name: "userinfo",
  aliases: ["ui", "whois"],
  description: "Shows detailed information about a user.",
  usage: "[@user]",
  category: "General",
  async execute({ message, args }) {
    const member = args[0] ? await resolveMember(message, args[0]) : (message.member as GuildMember);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const user = member.user;
    const roles = member.roles.cache
      .filter((r) => r.id !== message.guild!.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => r.toString())
      .slice(0, 10);
    await message.reply({
      embeds: [
        infoEmbed(`👤  ${user.tag}`)
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: "ID", value: user.id, inline: true },
            { name: "Nickname", value: member.displayName, inline: true },
            { name: "Bot", value: user.bot ? "Yes" : "No", inline: true },
            { name: "Created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: "Joined", value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : "Unknown", inline: true },
            { name: `Roles (${roles.length})`, value: roles.join(" ") || "None" }
          ),
      ],
    });
  },
});

// ── serverinfo ────────────────────────────────────────────────────────────────

register({
  name: "serverinfo",
  aliases: ["si", "guildinfo"],
  description: "Shows information about the current server.",
  usage: "",
  category: "General",
  async execute({ message }) {
    const g = message.guild!;
    const owner = await g.fetchOwner().catch(() => null);
    await message.reply({
      embeds: [
        infoEmbed(`🏠  ${g.name}`)
          .setThumbnail(g.iconURL({ size: 256 }) ?? null)
          .addFields(
            { name: "ID", value: g.id, inline: true },
            { name: "Owner", value: owner?.toString() ?? "Unknown", inline: true },
            { name: "Members", value: g.memberCount.toLocaleString(), inline: true },
            { name: "Channels", value: g.channels.cache.size.toString(), inline: true },
            { name: "Roles", value: g.roles.cache.size.toString(), inline: true },
            { name: "Boosts", value: (g.premiumSubscriptionCount ?? 0).toString(), inline: true },
            { name: "Verification", value: g.verificationLevel.toString(), inline: true },
            { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true }
          ),
      ],
    });
  },
});

// ── roles ─────────────────────────────────────────────────────────────────────

register({
  name: "roles",
  aliases: ["rolelist", "rl"],
  description: "Lists all roles, or gives a role to all members with `all <role>`.",
  usage: "[all <role name>]",
  category: "General",
  async execute({ message, args }) {
    const g = message.guild!;

    // ── -roles all <role> ─────────────────────────────────────────────────────
    if (args[0]?.toLowerCase() === "all") {
      if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
        return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
      const query = args.slice(1).join(" ").toLowerCase().trim();
      if (!query) return void message.reply({ embeds: [errorEmbed("Provide a role name. Usage: `-roles all <role name>`")] });
      const role =
        message.guild!.roles.cache.find(r => r.name.toLowerCase() === query) ??
        message.guild!.roles.cache.find(r => r.name.toLowerCase().includes(query)) ??
        null;
      if (!role) return void message.reply({ embeds: [errorEmbed(`Role \`${query}\` not found.`)] });
      const members = await message.guild!.members.fetch();
      const eligible = members.filter(m => !m.user.bot && !m.roles.cache.has(role.id));
      const sent = await message.reply({
        embeds: [infoEmbed(`⏳  Giving **${role.name}** to ${eligible.size} members...`)],
      });
      let success = 0, failed = 0;
      for (const [, member] of eligible) {
        try { await member.roles.add(role); success++; }
        catch { failed++; }
      }
      return void sent.edit({
        embeds: [successEmbed(`Gave **${role.name}** to **${success}** members.${failed ? ` (${failed} failed)` : ""}`)],
      });
    }

    const roles = [...g.roles.cache.values()]
      .filter(r => r.id !== g.id)
      .sort((a, b) => b.position - a.position);

    if (!roles.length) {
      return void message.reply({ embeds: [infoEmbed("No roles found in this server.")] });
    }

    const hoisted = roles.filter(r => r.hoist).length;
    const mentionable = roles.filter(r => r.mentionable).length;
    const botManaged = roles.filter(r => r.managed).length;

    const PAGE_SIZE = 20;
    const pages: string[] = [];
    for (let i = 0; i < roles.length; i += PAGE_SIZE) {
      pages.push(
        roles.slice(i, i + PAGE_SIZE).map(r => {
          const hex = r.color ? `\`#${r.color.toString(16).padStart(6, "0").toUpperCase()}\`` : "`#000000`";
          const tags: string[] = [];
          if (r.hoist) tags.push("hoisted");
          if (r.mentionable) tags.push("mentionable");
          if (r.managed) tags.push("bot");
          return `${r} ${hex}${tags.length ? `  *(${tags.join(", ")})*` : ""}`;
        }).join("\n")
      );
    }

    const makeEmbed = (pageIdx: number) =>
      new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`🏷️  ${g.name} — Roles (${roles.length})`)
        .setDescription(pages[pageIdx])
        .addFields(
          { name: "Total", value: roles.length.toString(), inline: true },
          { name: "Hoisted", value: hoisted.toString(), inline: true },
          { name: "Mentionable", value: mentionable.toString(), inline: true },
          { name: "Bot Managed", value: botManaged.toString(), inline: true },
        )
        .setFooter({ text: pages.length > 1 ? `Page ${pageIdx + 1} of ${pages.length}` : `${roles.length} roles total` });

    if (pages.length === 1) {
      return void message.reply({ embeds: [makeEmbed(0)] });
    }

    // Multiple pages — use a select menu
    const buildMenu = (current: number) =>
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("roles_page")
          .setPlaceholder(`Page ${current + 1} of ${pages.length} — select a page`)
          .addOptions(
            pages.map((_, i) => {
              const start = i * PAGE_SIZE + 1;
              const end = Math.min((i + 1) * PAGE_SIZE, roles.length);
              return new StringSelectMenuOptionBuilder()
                .setLabel(`Page ${i + 1}  (roles ${start}–${end})`)
                .setValue(String(i))
                .setDefault(i === current);
            })
          )
      );

    const reply = await message.reply({ embeds: [makeEmbed(0)], components: [buildMenu(0)] });

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: i => i.user.id === message.author.id,
      time: 60_000,
    });

    collector.on("collect", async interaction => {
      const page = parseInt(interaction.values[0], 10);
      await interaction.update({ embeds: [makeEmbed(page)], components: [buildMenu(page)] });
    });

    collector.on("end", async () => {
      const disabled = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("roles_page_disabled")
          .setPlaceholder("Session expired — run -roles again")
          .setDisabled(true)
          .addOptions(new StringSelectMenuOptionBuilder().setLabel("Expired").setValue("expired"))
      );
      await reply.edit({ components: [disabled] }).catch(() => null);
    });
  },
});

// ── avatar ────────────────────────────────────────────────────────────────────

register({
  name: "avatar",
  aliases: ["av", "pfp"],
  description: "Shows the avatar of a user.",
  usage: "[@user]",
  category: "General",
  async execute({ message, args }) {
    const member = args[0] ? await resolveMember(message, args[0]) : (message.member as GuildMember);
    const user = member?.user ?? message.author;
    const url = user.displayAvatarURL({ size: 1024 });
    await message.reply({
      embeds: [
        new EmbedBuilder().setColor(COLORS.primary).setTitle(`🖼  ${user.tag}'s Avatar`).setImage(url).setURL(url),
      ],
    });
  },
});

// ── membercount ───────────────────────────────────────────────────────────────

register({
  name: "membercount",
  aliases: ["mc"],
  description: "Shows member count breakdown for the server.",
  usage: "",
  category: "General",
  async execute({ message }) {
    const g = message.guild!;
    const all = g.members.cache;
    const humans = all.filter((m) => !m.user.bot).size;
    const bots = all.filter((m) => m.user.bot).size;
    const online = all.filter((m) => m.presence?.status === "online").size;
    await message.reply({
      embeds: [
        infoEmbed(`👥  ${g.name} — Member Count`)
          .addFields(
            { name: "Total", value: g.memberCount.toLocaleString(), inline: true },
            { name: "Humans", value: humans.toLocaleString(), inline: true },
            { name: "Bots", value: bots.toLocaleString(), inline: true },
            { name: "Online", value: online.toLocaleString(), inline: true }
          ),
      ],
    });
  },
});

// ── channelinfo ───────────────────────────────────────────────────────────────

register({
  name: "channelinfo",
  aliases: ["ci"],
  description: "Shows information about a channel.",
  usage: "[#channel]",
  category: "General",
  async execute({ message, args }) {
    const id = args[0]?.match(/\d{17,19}/)?.[0];
    const channel = (id ? message.guild!.channels.cache.get(id) : message.channel) as GuildChannel;
    if (!channel) return void message.reply({ embeds: [errorEmbed("Channel not found.")] });
    await message.reply({
      embeds: [
        infoEmbed(`#  ${channel.name}`)
          .addFields(
            { name: "ID", value: channel.id, inline: true },
            { name: "Type", value: ChannelType[channel.type], inline: true },
            { name: "Created", value: `<t:${Math.floor(channel.createdTimestamp! / 1000)}:R>`, inline: true },
            { name: "Position", value: channel.position.toString(), inline: true }
          ),
      ],
    });
  },
});

// ── roleinfo ─────────────────────────────────────────────────────────────────

register({
  name: "roleinfo",
  aliases: ["ri"],
  description: "Shows information about a role.",
  usage: "<@role|id|name>",
  category: "General",
  async execute({ message, args }) {
    const arg = args.join(" ");
    const id = arg?.match(/\d{17,19}/)?.[0];
    let role = id ? message.guild!.roles.cache.get(id) : null;
    if (!role && arg) {
      role = message.guild!.roles.cache.find((r) => r.name.toLowerCase() === arg.toLowerCase()) ?? null;
    }
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
    await message.reply({
      embeds: [
        infoEmbed(`🏷  ${role.name}`)
          .setColor(role.color || COLORS.primary)
          .addFields(
            { name: "ID", value: role.id, inline: true },
            { name: "Color", value: role.hexColor, inline: true },
            { name: "Members", value: role.members.size.toString(), inline: true },
            { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
            { name: "Hoisted", value: role.hoist ? "Yes" : "No", inline: true },
            { name: "Position", value: role.position.toString(), inline: true },
            { name: "Created", value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R>`, inline: true }
          ),
      ],
    });
  },
});

// ── inrole ────────────────────────────────────────────────────────────────────

register({
  name: "inrole",
  description: "Lists members who have a specific role.",
  usage: "<@role|id|name>",
  category: "General",
  async execute({ message, args }) {
    const arg = args.join(" ");
    const id = arg?.match(/\d{17,19}/)?.[0];
    let role = id ? message.guild!.roles.cache.get(id) : null;
    if (!role && arg) {
      role = message.guild!.roles.cache.find((r) => r.name.toLowerCase() === arg.toLowerCase()) ?? null;
    }
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
    const members = role.members.map((m) => m.toString()).slice(0, 30);
    await message.reply({
      embeds: [
        infoEmbed(`👥  Members with ${role.name} (${role.members.size})`)
          .setDescription(members.join(" ") || "None"),
      ],
    });
  },
});

// ── emojis ────────────────────────────────────────────────────────────────────

register({
  name: "emojis",
  description: "Lists all custom emojis in the server.",
  usage: "",
  category: "General",
  async execute({ message }) {
    const emojis = [...message.guild!.emojis.cache.values()].slice(0, 30).map((e) => e.toString()).join(" ");
    await message.reply({
      embeds: [
        infoEmbed(`😄  Server Emojis (${message.guild!.emojis.cache.size})`)
          .setDescription(emojis || "No custom emojis."),
      ],
    });
  },
});

// ── firstmessage ──────────────────────────────────────────────────────────────

register({
  name: "firstmessage",
  aliases: ["first"],
  description: "Links to the first message in this channel.",
  usage: "",
  category: "General",
  async execute({ message }) {
    const msgs = await message.channel.messages.fetch({ limit: 1, after: "0" });
    const first = msgs.first();
    if (!first) return void message.reply({ embeds: [errorEmbed("Could not find the first message.")] });
    await message.reply({
      embeds: [
        infoEmbed("📌  First Message")
          .setDescription(`[Jump to first message](${first.url})`)
          .addFields({ name: "Author", value: first.author.toString(), inline: true }),
      ],
    });
  },
});

// ── permissions ───────────────────────────────────────────────────────────────

register({
  name: "permissions",
  aliases: ["perms"],
  description: "Shows a user's permissions in the current channel.",
  usage: "[@user]",
  category: "General",
  async execute({ message, args }) {
    const member = args[0] ? await resolveMember(message, args[0]) : (message.member as GuildMember);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const perms = member.permissionsIn(message.channel as TextChannel);
    const list = perms.toArray().map((p) => `\`${p}\``).join("  ") || "None";
    await message.reply({
      embeds: [infoEmbed(`🔐  ${member.displayName}'s Permissions`).setDescription(list)],
    });
  },
});

// ── color ─────────────────────────────────────────────────────────────────────

register({
  name: "color",
  aliases: ["colour"],
  description: "Shows info about a hex color.",
  usage: "<#hexcode>",
  category: "General",
  async execute({ message, args }) {
    const hex = args[0]?.replace("#", "");
    if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex))
      return void message.reply({ embeds: [errorEmbed("Provide a valid 6-digit hex color, e.g. `#5865f2`.")] });
    const num = parseInt(hex, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(num)
          .setTitle(`🎨  #${hex.toUpperCase()}`)
          .addFields(
            { name: "HEX", value: `#${hex.toUpperCase()}`, inline: true },
            { name: "RGB", value: `rgb(${r}, ${g}, ${b})`, inline: true },
            { name: "INT", value: num.toString(), inline: true }
          ),
      ],
    });
  },
});

// ── 8ball ─────────────────────────────────────────────────────────────────────

const BALL_RESPONSES = [
  "It is certain.", "Without a doubt.", "Yes, definitely.", "You may rely on it.",
  "As I see it, yes.", "Most likely.", "Outlook good.", "Signs point to yes.",
  "Reply hazy, try again.", "Ask again later.", "Better not tell you now.",
  "Cannot predict now.", "Don't count on it.", "My reply is no.",
  "My sources say no.", "Outlook not so good.", "Very doubtful.",
];

register({
  name: "8ball",
  aliases: ["ball", "ask"],
  description: "Ask the magic 8 ball a question.",
  usage: "<question>",
  category: "General",
  async execute({ message, args }) {
    if (!args.length) return void message.reply({ embeds: [errorEmbed("Ask a question.")] });
    const resp = BALL_RESPONSES[Math.floor(Math.random() * BALL_RESPONSES.length)];
    await message.reply({
      embeds: [
        infoEmbed("🎱  Magic 8-Ball")
          .addFields(
            { name: "Question", value: args.join(" ") },
            { name: "Answer", value: resp }
          ),
      ],
    });
  },
});

// ── flip ──────────────────────────────────────────────────────────────────────

register({
  name: "flip",
  aliases: ["coin", "coinflip"],
  description: "Flips a coin.",
  usage: "",
  category: "General",
  async execute({ message }) {
    const result = Math.random() < 0.5 ? "🪙  **Heads!**" : "🪙  **Tails!**";
    await message.reply({ embeds: [infoEmbed(result)] });
  },
});

// ── choose ────────────────────────────────────────────────────────────────────

register({
  name: "choose",
  aliases: ["pick"],
  description: "Chooses randomly between given options.",
  usage: "<option1> | <option2> | ...",
  category: "General",
  async execute({ message, args }) {
    const opts = args.join(" ").split("|").map((s) => s.trim()).filter(Boolean);
    if (opts.length < 2) return void message.reply({ embeds: [errorEmbed("Provide at least 2 options separated by `|`.")] });
    const pick = opts[Math.floor(Math.random() * opts.length)];
    await message.reply({
      embeds: [
        infoEmbed("🎲  I choose…")
          .setDescription(`**${pick}**`)
          .setFooter({ text: `From: ${opts.join(" | ")}` }),
      ],
    });
  },
});

// ── calc ──────────────────────────────────────────────────────────────────────

register({
  name: "calc",
  aliases: ["calculate", "math"],
  description: "Evaluates a math expression.",
  usage: "<expression>",
  category: "General",
  async execute({ message, args }) {
    const expr = args.join(" ");
    if (!expr) return void message.reply({ embeds: [errorEmbed("Provide a math expression.")] });
    if (!/^[\d\s+\-*/().%^]+$/.test(expr))
      return void message.reply({ embeds: [errorEmbed("Only numbers and operators (+, -, *, /, %, .) are allowed.")] });
    try {
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${expr})`)();
      await message.reply({
        embeds: [
          infoEmbed("🧮  Calculator")
            .addFields(
              { name: "Expression", value: `\`${expr}\``, inline: true },
              { name: "Result", value: `\`${result}\``, inline: true }
            ),
        ],
      });
    } catch {
      await message.reply({ embeds: [errorEmbed("Could not evaluate that expression.")] });
    }
  },
});

// ── poll ──────────────────────────────────────────────────────────────────────

register({
  name: "poll",
  description: "Creates a reaction poll.",
  usage: "<question> | <option1> | <option2> | ...",
  category: "General",
  async execute({ message, args }) {
    const parts = args.join(" ").split("|").map((s) => s.trim());
    const question = parts[0];
    const options = parts.slice(1, 11);
    if (!question) return void message.reply({ embeds: [errorEmbed("Provide a question.")] });
    const NUMBER_EMOJIS = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
    let desc = "";
    if (options.length >= 2) {
      desc = options.map((o, i) => `${NUMBER_EMOJIS[i]}  ${o}`).join("\n");
    }
    const poll = await (message.channel as TextChannel).send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(`📊  ${question}`)
          .setDescription(desc || "React with 👍 or 👎")
          .setFooter({ text: `Poll by ${message.author.tag}` }),
      ],
    });
    if (options.length >= 2) {
      for (let i = 0; i < options.length; i++) await poll.react(NUMBER_EMOJIS[i]);
    } else {
      await poll.react("👍");
      await poll.react("👎");
    }
    await message.delete().catch(() => null);
  },
});

// ── snipe ─────────────────────────────────────────────────────────────────────

register({
  name: "snipe",
  aliases: ["s"],
  description: "Shows the last deleted message in this channel.",
  usage: "",
  category: "General",
  async execute({ message }) {
    const sniped = snipeStore.get(message.channel.id);
    if (!sniped) return void message.reply({ embeds: [errorEmbed("Nothing to snipe here.")] });
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.primary)
          .setAuthor({ name: sniped.authorTag, iconURL: sniped.authorAvatar ?? undefined })
          .setDescription(sniped.content || "*[no text]*")
          .setFooter({ text: `Deleted ${fmtDuration(Date.now() - sniped.timestamp)} ago` }),
      ],
    });
  },
});

// ── afk ───────────────────────────────────────────────────────────────────────

register({
  name: "afk",
  description: "Sets your AFK status. Cleared when you next send a message.",
  usage: "[reason]",
  category: "General",
  async execute({ message, args }) {
    const reason = args.join(" ") || "AFK";
    afkStore.set(`${message.guild!.id}:${message.author.id}`, reason);
    await message.reply({ embeds: [successEmbed(`You are now AFK: **${reason}**`)] });
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ MODERATION COMMANDS ═════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

// ── ban ───────────────────────────────────────────────────────────────────────

register({
  name: "ban",
  description: "Bans a member from the server.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a user.")] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.bannable) return void message.reply({ embeds: [errorEmbed("I cannot ban this user.")] });
    const reason = args.slice(1).join(" ") || "No reason provided";
    await member.ban({ reason: `${message.author.tag}: ${reason}` });
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** has been banned.\n**Reason:** ${reason}`)] });
  },
});

// ── softban ───────────────────────────────────────────────────────────────────

register({
  name: "softban",
  aliases: ["sban"],
  description: "Bans then immediately unbans a member (clears their recent messages).",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a user.")] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.bannable) return void message.reply({ embeds: [errorEmbed("I cannot ban this user.")] });
    const reason = args.slice(1).join(" ") || "Softban";
    await member.ban({ deleteMessageSeconds: 604800, reason: `Softban by ${message.author.tag}: ${reason}` });
    await message.guild!.bans.remove(member.id, "Softban - automatic unban");
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** has been softbanned (messages cleared).\n**Reason:** ${reason}`)] });
  },
});

// ── hackban ───────────────────────────────────────────────────────────────────

register({
  name: "hackban",
  aliases: ["forceban", "idban"],
  description: "Bans a user by ID, even if they are not in the server.",
  usage: "<userId> [reason]",
  category: "Moderation",
  async execute({ message, args, client }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a user ID.")] });
    const id = args[0].match(/\d{17,19}/)?.[0];
    if (!id) return void message.reply({ embeds: [errorEmbed("Invalid user ID.")] });
    const reason = args.slice(1).join(" ") || "No reason provided";
    try {
      await message.guild!.bans.create(id, { reason: `Hackban by ${message.author.tag}: ${reason}` });
      const user = await resolveUser(client, id);
      await message.reply({ embeds: [successEmbed(`**${user?.tag ?? id}** has been banned.\n**Reason:** ${reason}`)] });
    } catch {
      await message.reply({ embeds: [errorEmbed("Could not ban that user ID.")] });
    }
  },
});

// ── unban ─────────────────────────────────────────────────────────────────────

register({
  name: "unban",
  description: "Unbans a user by ID.",
  usage: "<userId> [reason]",
  category: "Moderation",
  async execute({ message, args, client }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a user ID.")] });
    const id = args[0].match(/\d{17,19}/)?.[0];
    if (!id) return void message.reply({ embeds: [errorEmbed("Invalid user ID.")] });
    const reason = args.slice(1).join(" ") || "No reason provided";
    try {
      await message.guild!.bans.remove(id, `${message.author.tag}: ${reason}`);
      const user = await resolveUser(client, id);
      await message.reply({ embeds: [successEmbed(`**${user?.tag ?? id}** has been unbanned.`)] });
    } catch {
      await message.reply({ embeds: [errorEmbed("That user is not banned or the ID is invalid.")] });
    }
  },
});

// ── tempban ───────────────────────────────────────────────────────────────────

register({
  name: "tempban",
  aliases: ["tban"],
  description: "Bans a member for a set duration (e.g. 10m, 1h, 7d).",
  usage: "<@user|id> <duration> [reason]",
  category: "Moderation",
  async execute({ message, args, client }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}tempban <@user> <duration> [reason]\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.bannable) return void message.reply({ embeds: [errorEmbed("I cannot ban this user.")] });
    const ms = parseDuration(args[1]);
    if (!ms) return void message.reply({ embeds: [errorEmbed("Invalid duration. Use `10m`, `1h`, `2d`, etc.")] });
    const reason = args.slice(2).join(" ") || "No reason provided";
    await member.ban({ reason: `Tempban (${fmtDuration(ms)}) by ${message.author.tag}: ${reason}` });
    const timerKey = `${message.guild!.id}:${member.id}`;
    const existing = tempBanTimers.get(timerKey);
    if (existing) clearTimeout(existing);
    tempBanTimers.set(timerKey, setTimeout(async () => {
      tempBanTimers.delete(timerKey);
      await message.guild!.bans.remove(member.id, "Tempban expired").catch(() => null);
    }, ms));
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** has been banned for **${fmtDuration(ms)}**.\n**Reason:** ${reason}`)] });
  },
});


// ── kick ──────────────────────────────────────────────────────────────────────

register({
  name: "kick",
  description: "Kicks a member from the server.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.KickMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Kick Members** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a user.")] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.kickable) return void message.reply({ embeds: [errorEmbed("I cannot kick this user.")] });
    const reason = args.slice(1).join(" ") || "No reason provided";
    await member.kick(`${message.author.tag}: ${reason}`);
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** has been kicked.\n**Reason:** ${reason}`)] });
  },
});

// ── mute ─────────────────────────────────────────────────────────────────────

register({
  name: "mute",
  aliases: ["timeout", "to"],
  description: "Times out a member for a given duration.",
  usage: "<@user|id> <duration> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}mute <@user> <duration> [reason]\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const ms = parseDuration(args[1]);
    if (!ms || ms > 28 * 864e5) return void message.reply({ embeds: [errorEmbed("Invalid duration (max 28d).")] });
    const reason = args.slice(2).join(" ") || "No reason provided";
    await member.timeout(ms, `${message.author.tag}: ${reason}`);
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** muted for **${fmtDuration(ms)}**.\n**Reason:** ${reason}`)] });
  },
});

// ── unmute ────────────────────────────────────────────────────────────────────

register({
  name: "unmute",
  aliases: ["untimeout"],
  description: "Removes a timeout from a member.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.communicationDisabledUntil) return void message.reply({ embeds: [errorEmbed("This member is not muted.")] });
    await member.timeout(null);
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}**'s timeout removed.`)] });
  },
});

// ── deafen ────────────────────────────────────────────────────────────────────

register({
  name: "deafen",
  aliases: ["deaf"],
  description: "Server-deafens a member in voice.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.DeafenMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Deafen Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.voice.channel) return void message.reply({ embeds: [errorEmbed("That user is not in a voice channel.")] });
    const reason = args.slice(1).join(" ") || "No reason";
    await member.voice.setDeaf(true, reason);
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** has been server-deafened.`)] });
  },
});

// ── undeafen ─────────────────────────────────────────────────────────────────

register({
  name: "undeafen",
  aliases: ["undeaf"],
  description: "Removes server-deafen from a member.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.DeafenMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Deafen Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.voice.channel) return void message.reply({ embeds: [errorEmbed("That user is not in a voice channel.")] });
    await member.voice.setDeaf(false);
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** is no longer server-deafened.`)] });
  },
});

// ── vckick ────────────────────────────────────────────────────────────────────

register({
  name: "vckick",
  aliases: ["vcdisconnect", "dvc"],
  description: "Disconnects a member from their voice channel.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.MoveMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Move Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.voice.channel) return void message.reply({ embeds: [errorEmbed("That user is not in a voice channel.")] });
    await member.voice.disconnect();
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** has been disconnected from voice.`)] });
  },
});

// ── vcmove ────────────────────────────────────────────────────────────────────

register({
  name: "vcmove",
  aliases: ["move"],
  description: "Moves a member to a different voice channel.",
  usage: "<@user|id> <#channel|channelId>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.MoveMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Move Members** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}vcmove <@user> <#channel>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.voice.channel) return void message.reply({ embeds: [errorEmbed("That user is not in a voice channel.")] });
    const vcId = args[1].match(/\d{17,19}/)?.[0];
    const vc = vcId ? message.guild!.channels.cache.get(vcId) as VoiceChannel : null;
    if (!vc || !vc.isVoiceBased()) return void message.reply({ embeds: [errorEmbed("Could not find that voice channel.")] });
    await member.voice.setChannel(vc);
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** moved to **${vc.name}**.`)] });
  },
});

// ── voiceban ─────────────────────────────────────────────────────────────────

register({
  name: "voiceban",
  aliases: ["vban"],
  description: "Prevents a member from joining any voice channel.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const voiceChannels = message.guild!.channels.cache.filter((c) => c.isVoiceBased());
    let count = 0;
    for (const [, ch] of voiceChannels) {
      await (ch as GuildChannel).permissionOverwrites.edit(member, { Connect: false }).catch(() => null);
      count++;
    }
    if (member.voice.channel) await member.voice.disconnect().catch(() => null);
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** is now voice-banned (${count} channels).`)] });
  },
});

// ── voiceunban ────────────────────────────────────────────────────────────────

register({
  name: "voiceunban",
  aliases: ["vunban"],
  description: "Restores a member's access to voice channels.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const voiceChannels = message.guild!.channels.cache.filter((c) => c.isVoiceBased());
    for (const [, ch] of voiceChannels) {
      await (ch as GuildChannel).permissionOverwrites.delete(member).catch(() => null);
    }
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}**'s voice ban has been removed.`)] });
  },
});

// ── warn ─────────────────────────────────────────────────────────────────────

register({
  name: "warn",
  description: "Issues a warning to a member.",
  usage: "<@user|id> <reason>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed("Provide a user and a reason.")] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const reason = args.slice(1).join(" ");
    const key = `${message.guild!.id}:${member.id}`;
    const list = warningsStore.get(key) ?? [];
    const warnId = _warnId++;
    list.push({ id: warnId, reason, moderator: message.author.tag, timestamp: Date.now() });
    warningsStore.set(key, list);
    try {
      await member.user.send({
        embeds: [
          new EmbedBuilder().setColor(COLORS.warning)
            .setTitle(`⚠️  Warning — ${message.guild!.name}`)
            .setDescription(`You have been warned by **${message.author.tag}**.\n**Reason:** ${reason}`)
            .setTimestamp(),
        ],
      });
    } catch {}
    await message.reply({ embeds: [warnEmbed(`**${member.user.tag}** warned (Case #${warnId}).\n**Reason:** ${reason}`)] });
  },
});

// ── warnings ─────────────────────────────────────────────────────────────────

register({
  name: "warnings",
  aliases: ["warns", "warnlist"],
  description: "Shows all warnings for a member.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const key = `${message.guild!.id}:${member.id}`;
    const list = warningsStore.get(key) ?? [];
    if (!list.length) return void message.reply({ embeds: [successEmbed(`**${member.user.tag}** has no warnings.`)] });
    const fields = list.slice(-10).map((w) => ({
      name: `Case #${w.id}`,
      value: `**Reason:** ${w.reason}\n**By:** ${w.moderator}\n**When:** <t:${Math.floor(w.timestamp / 1000)}:R>`,
    }));
    await message.reply({
      embeds: [infoEmbed(`⚠️  Warnings for ${member.user.tag} (${list.length})`).addFields(...fields)],
    });
  },
});

// ── clearwarns ────────────────────────────────────────────────────────────────

register({
  name: "clearwarns",
  aliases: ["clearwarnings", "resetwarns"],
  description: "Clears all warnings for a member.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    warningsStore.delete(`${message.guild!.id}:${member.id}`);
    await message.reply({ embeds: [successEmbed(`All warnings cleared for **${member.user.tag}**.`)] });
  },
});

// ── delwarn ───────────────────────────────────────────────────────────────────

register({
  name: "delwarn",
  aliases: ["removewarn", "unwarn"],
  description: "Removes a specific warning by case ID.",
  usage: "<@user|id> <caseId>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}delwarn <@user> <caseId>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const caseId = parseInt(args[1], 10);
    const key = `${message.guild!.id}:${member.id}`;
    const list = warningsStore.get(key) ?? [];
    const idx = list.findIndex((w) => w.id === caseId);
    if (idx === -1) return void message.reply({ embeds: [errorEmbed(`Case #${caseId} not found.`)] });
    list.splice(idx, 1);
    warningsStore.set(key, list);
    await message.reply({ embeds: [successEmbed(`Case #${caseId} removed from **${member.user.tag}**.`)] });
  },
});

// ── purge ─────────────────────────────────────────────────────────────────────

register({
  name: "purge",
  aliases: ["clear", "prune", "clean"],
  description: "Bulk-deletes messages in the channel (1–100).",
  usage: "<amount> [@user]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1 || n > 100)
      return void message.reply({ embeds: [errorEmbed("Provide a number between 1 and 100.")] });
    const filterMember = args[1] ? await resolveMember(message, args[1]) : null;
    await message.delete().catch(() => null);
    let msgs = await message.channel.messages.fetch({ limit: 100 });
    if (filterMember) msgs = msgs.filter((m) => m.author.id === filterMember.id) as typeof msgs;
    const toDelete = [...msgs.values()].slice(0, n);
    if ("bulkDelete" in message.channel) {
      const deleted = await message.channel.bulkDelete(toDelete, true);
      const reply = await message.channel.send({ embeds: [successEmbed(`Deleted **${deleted.size}** message(s).`)] });
      setTimeout(() => reply.delete().catch(() => null), 4000);
    }
  },
});

// ── slowmode ─────────────────────────────────────────────────────────────────

register({
  name: "slowmode",
  aliases: ["slow"],
  description: "Sets slowmode on the channel (0 to disable, max 21600s).",
  usage: "<seconds>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    const s = parseInt(args[0], 10);
    if (isNaN(s) || s < 0 || s > 21600)
      return void message.reply({ embeds: [errorEmbed("Value must be 0–21600 seconds.")] });
    if (!("setRateLimitPerUser" in message.channel)) return;
    await (message.channel as TextChannel).setRateLimitPerUser(s);
    await message.reply({ embeds: [successEmbed(s === 0 ? "Slowmode disabled." : `Slowmode set to **${s}s**.`)] });
  },
});

// ── lock ─────────────────────────────────────────────────────────────────────

register({
  name: "lock",
  description: "Locks the channel so @everyone cannot send messages.",
  usage: "[reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    if (!("permissionOverwrites" in message.channel)) return;
    await (message.channel as TextChannel).permissionOverwrites.edit(message.guild!.id, { SendMessages: false });
    await message.reply({ embeds: [successEmbed(`🔒  Channel locked. ${args.join(" ") ? `**Reason:** ${args.join(" ")}` : ""}`)] });
  },
});

// ── unlock ────────────────────────────────────────────────────────────────────

register({
  name: "unlock",
  description: "Unlocks the channel.",
  usage: "[reason]",
  category: "Moderation",
  async execute({ message }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    if (!("permissionOverwrites" in message.channel)) return;
    await (message.channel as TextChannel).permissionOverwrites.edit(message.guild!.id, { SendMessages: null });
    await message.reply({ embeds: [successEmbed("🔓  Channel unlocked.")] });
  },
});

// ── lockdown ─────────────────────────────────────────────────────────────────

register({
  name: "lockdown",
  aliases: ["ld"],
  description: "Locks ALL text channels in the server.",
  usage: "[reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    const reason = args.join(" ") || "Server lockdown";
    const textChannels = message.guild!.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText && "permissionOverwrites" in c
    );
    let count = 0;
    for (const [, ch] of textChannels) {
      await (ch as TextChannel).permissionOverwrites.edit(message.guild!.id, { SendMessages: false }).catch(() => null);
      count++;
    }
    await message.reply({ embeds: [successEmbed(`🔒  **Lockdown active.** Locked **${count}** channels.\n**Reason:** ${reason}`)] });
  },
});

// ── unlockdown ────────────────────────────────────────────────────────────────

register({
  name: "unlockdown",
  aliases: ["uld", "unlockall"],
  description: "Unlocks ALL text channels in the server.",
  usage: "",
  category: "Moderation",
  async execute({ message }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    const textChannels = message.guild!.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText && "permissionOverwrites" in c
    );
    let count = 0;
    for (const [, ch] of textChannels) {
      await (ch as TextChannel).permissionOverwrites.edit(message.guild!.id, { SendMessages: null }).catch(() => null);
      count++;
    }
    await message.reply({ embeds: [successEmbed(`🔓  Lockdown lifted. Unlocked **${count}** channels.`)] });
  },
});

// ── nick ─────────────────────────────────────────────────────────────────────

register({
  name: "nick",
  aliases: ["nickname"],
  description: "Changes or resets a member's nickname.",
  usage: "<@user|id> <nickname|reset>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageNicknames))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Nicknames** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}nick <@user> <name|reset>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const newNick = args.slice(1).join(" ");
    const final = newNick.toLowerCase() === "reset" ? null : newNick;
    await member.setNickname(final);
    await message.reply({ embeds: [successEmbed(final ? `Nickname set to **${final}** for ${member}.` : `Nickname reset for ${member}.`)] });
  },
});

// ── role (toggle) ─────────────────────────────────────────────────────────────

register({
  name: "role",
  description: "Toggles a role on a member (adds if missing, removes if present).",
  usage: "<@user|id> <@role|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}role <@user> <role name or @role>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    // Resolve by mention/ID first, then by exact name, then partial name
    const roleId = args[1].match(/\d{17,19}/)?.[0];
    let role = roleId ? (message.guild!.roles.cache.get(roleId) ?? null) : null;
    if (!role) {
      const query = args.slice(1).join(" ").toLowerCase().trim();
      role =
        message.guild!.roles.cache.find(r => r.name.toLowerCase() === query) ??
        message.guild!.roles.cache.find(r => r.name.toLowerCase().includes(query)) ??
        null;
    }
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found. Use the exact role name or mention it.")] });
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      await message.reply({ embeds: [successEmbed(`Removed **${role.name}** from ${member}.`)] });
    } else {
      await member.roles.add(role);
      await message.reply({ embeds: [successEmbed(`Added **${role.name}** to ${member}.`)] });
    }
  },
});

// ── addrole ───────────────────────────────────────────────────────────────────

register({
  name: "addrole",
  aliases: ["ar", "giverole"],
  description: "Adds a role to a member.",
  usage: "<@user|id> <@role|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}addrole <@user> <@role>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const roleIdFromArg = args[1].match(/\d{17,19}/)?.[0];
    const roleQuery = args.slice(1).join(" ").toLowerCase().trim();
    const role = roleIdFromArg
      ? (message.guild!.roles.cache.get(roleIdFromArg) ?? null)
      : (message.guild!.roles.cache.find(r => r.name.toLowerCase() === roleQuery)
        ?? message.guild!.roles.cache.find(r => r.name.toLowerCase().includes(roleQuery))
        ?? null);
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found. Use the exact role name, mention it, or provide its ID.")] });
    await member.roles.add(role);
    await message.reply({ embeds: [successEmbed(`Added **${role.name}** to ${member}.`)] });
  },
});

// ── removerole ────────────────────────────────────────────────────────────────

register({
  name: "removerole",
  aliases: ["rr", "takerole"],
  description: "Removes a role from a member.",
  usage: "<@user|id> <@role|id|name>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}removerole <@user> <@role>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const roleIdFromArg2 = args[1].match(/\d{17,19}/)?.[0];
    const roleQuery2 = args.slice(1).join(" ").toLowerCase().trim();
    const role = roleIdFromArg2
      ? (message.guild!.roles.cache.get(roleIdFromArg2) ?? null)
      : (message.guild!.roles.cache.find(r => r.name.toLowerCase() === roleQuery2)
        ?? message.guild!.roles.cache.find(r => r.name.toLowerCase().includes(roleQuery2))
        ?? null);
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found. Use the exact role name, mention it, or provide its ID.")] });
    await member.roles.remove(role);
    await message.reply({ embeds: [successEmbed(`Removed **${role.name}** from ${member}.`)] });
  },
});

// ── strip ─────────────────────────────────────────────────────────────────────

register({
  name: "strip",
  aliases: ["stripall", "stroleroles"],
  description: "Removes all removable roles from a member.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const removable = member.roles.cache.filter((r) => r.id !== message.guild!.id && !r.managed);
    await member.roles.remove(removable);
    await message.reply({ embeds: [successEmbed(`Stripped **${removable.size}** roles from **${member.user.tag}**.`)] });
  },
});

// ── nuke ─────────────────────────────────────────────────────────────────────

register({
  name: "nuke",
  description: "Clones the channel and deletes the original, wiping all messages.",
  usage: "[reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    const reason = args.join(" ") || "Channel nuked";
    const ch = message.channel as TextChannel;
    const newCh = await ch.clone({ reason: `${message.author.tag}: ${reason}` });
    await newCh.setPosition(ch.position);
    await ch.delete(reason);
    const sent = await newCh.send({ embeds: [successEmbed(`💥  Channel nuked by **${message.author.tag}**.`)] });
    setTimeout(() => sent.delete().catch(() => null), 5000);
  },
});

// ── say ───────────────────────────────────────────────────────────────────────

register({
  name: "say",
  description: "Makes the bot send a message in the current channel.",
  usage: "<message>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    if (!args.length) return void message.reply({ embeds: [errorEmbed("Provide a message.")] });
    await message.delete().catch(() => null);
    await (message.channel as TextChannel).send(args.join(" "));
  },
});

// ── announce ─────────────────────────────────────────────────────────────────

register({
  name: "announce",
  aliases: ["ann"],
  description: "Sends an announcement embed to a channel.",
  usage: "<#channel> <message>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}announce <#channel> <message>\``)] });
    const chId = args[0].match(/\d{17,19}/)?.[0];
    const target = chId ? (message.guild!.channels.cache.get(chId) as TextChannel) : null;
    if (!target?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid channel.")] });
    const text = args.slice(1).join(" ");
    await target.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle("📢  Announcement")
          .setDescription(text)
          .setFooter({ text: `By ${message.author.tag}` })
          .setTimestamp(),
      ],
    });
    await message.reply({ embeds: [successEmbed(`Announcement sent to ${target}.`)] });
  },
});

// ── dm ────────────────────────────────────────────────────────────────────────

register({
  name: "dm",
  description: "Sends a DM to a user.",
  usage: "<@user|id> <message>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}dm <@user> <message>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const text = args.slice(1).join(" ");
    try {
      await member.user.send({
        embeds: [
          new EmbedBuilder().setColor(COLORS.primary)
            .setTitle(`📨  Message from ${message.guild!.name}`)
            .setDescription(text)
            .setFooter({ text: `Sent by ${message.author.tag}` }),
        ],
      });
      await message.reply({ embeds: [successEmbed(`DM sent to **${member.user.tag}**.`)] });
    } catch {
      await message.reply({ embeds: [errorEmbed("Could not send DM — the user may have DMs disabled.")] });
    }
  },
});

// ── jail ─────────────────────────────────────────────────────────────────────

register({
  name: "jail",
  description: "Restricts a member so they can only see the jail channel.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const reason = args.slice(1).join(" ") || "No reason";
    const guild = message.guild!;
    const { jailSettingsTable } = await import("@workspace/db/schema");

    // Fetch jail settings from DB
    let jailChannelId: string | null = null;
    let jailRoleId: string | null = null;
    try {
      const [row] = await db.select().from(jailSettingsTable).where(eq(jailSettingsTable.guildId, guild.id)).limit(1);
      jailChannelId = row?.jailChannelId ?? null;
      jailRoleId = row?.jailRoleId ?? null;
    } catch {}

    // ── Ensure Jailed role exists ──────────────────────────────────────────
    let jailRole = jailRoleId
      ? (guild.roles.cache.get(jailRoleId) ?? await guild.roles.fetch(jailRoleId).catch(() => null))
      : null;

    if (!jailRole) {
      // Check for an existing role named "Jailed"
      jailRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "jailed") ?? null;
      if (!jailRole) {
        jailRole = await guild.roles.create({
          name: "Jailed",
          color: 0x808080,
          hoist: false,
          mentionable: false,
          permissions: [],
          reason: "Auto-created jail role",
        }).catch(() => null);
      }
      if (jailRole) {
        jailRoleId = jailRole.id;
        try {
          await db.insert(jailSettingsTable)
            .values({ guildId: guild.id, jailChannelId, jailRoleId })
            .onConflictDoUpdate({ target: jailSettingsTable.guildId, set: { jailRoleId, updatedAt: new Date() } });
        } catch {}
      }
    }

    // ── Ensure jail channel exists ─────────────────────────────────────────
    let jailChannel = jailChannelId
      ? (guild.channels.cache.get(jailChannelId) as TextChannel | undefined) ?? null
      : null;

    if (!jailChannel) {
      // Check for an existing channel named "jail"
      jailChannel = (guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === "jail"
      ) as TextChannel | undefined) ?? null;

      if (!jailChannel) {
        // Build permission overwrites: deny @everyone, allow jailed role + bot
        const overwrites: Parameters<typeof guild.channels.create>[0]["permissionOverwrites"] = [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        ];
        if (guild.members.me) {
          overwrites.push({ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
        }
        if (jailRole) {
          overwrites.push({ id: jailRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        }
        jailChannel = await guild.channels.create({
          name: "jail",
          type: ChannelType.GuildText,
          permissionOverwrites: overwrites,
          topic: "🔒 Jail — only jailed members and moderators can see this channel.",
          reason: "Auto-created jail channel",
        }).catch(() => null) as TextChannel | null;
      } else {
        // Existing channel found — update its overwrites to match expectations
        if (jailRole) {
          await (jailChannel as TextChannel).permissionOverwrites.edit(jailRole, { ViewChannel: true, SendMessages: true }).catch(() => null);
        }
        await (jailChannel as TextChannel).permissionOverwrites.edit(guild.id, { ViewChannel: false }).catch(() => null);
        if (guild.members.me) {
          await (jailChannel as TextChannel).permissionOverwrites.edit(guild.members.me.id, { ViewChannel: true, SendMessages: true, ManageMessages: true }).catch(() => null);
        }
      }

      if (jailChannel) {
        jailChannelId = jailChannel.id;
        try {
          await db.insert(jailSettingsTable)
            .values({ guildId: guild.id, jailChannelId, jailRoleId })
            .onConflictDoUpdate({ target: jailSettingsTable.guildId, set: { jailChannelId, updatedAt: new Date() } });
        } catch {}
      }
    }

    // ── Apply jail: assign Jailed role + block all other channels ──────────
    // 1. Remove all current roles (except @everyone) and assign Jailed role
    if (jailRole) {
      const rolesToRemove = member.roles.cache.filter((r) => r.id !== guild.id && r.id !== jailRole!.id);
      // Back up roles before stripping so unjail can restore them
      if (rolesToRemove.size) {
        jailRoleBackupStore.set(`${guild.id}:${member.id}`, [...rolesToRemove.keys()]);
        await member.roles.remove([...rolesToRemove.keys()], `Jailed: ${reason}`).catch(() => null);
      }
      if (!member.roles.cache.has(jailRole.id)) {
        await member.roles.add(jailRole, `Jailed: ${reason}`).catch(() => null);
      }
    }

    // 2. Deny ViewChannel for this user in all text channels except the jail channel
    //    (belt-and-suspenders alongside the role-based restriction)
    const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText);
    for (const [, ch] of textChannels) {
      if (jailChannelId && ch.id === jailChannelId) {
        // Ensure the user explicitly can see the jail channel
        await (ch as TextChannel).permissionOverwrites.edit(member, { ViewChannel: true, SendMessages: true }).catch(() => null);
      } else {
        await (ch as TextChannel).permissionOverwrites.edit(member, { ViewChannel: false }).catch(() => null);
      }
    }

    const jailMention = jailChannel ? ` They can only see <#${jailChannel.id}>.` : "";
    await message.reply({ embeds: [warnEmbed(`🔒  **${member.user.tag}** has been jailed.\n**Reason:** ${reason}${jailMention}`)] });
  },
});

// ── unjail ────────────────────────────────────────────────────────────────────

register({
  name: "unjail",
  description: "Releases a member from jail, restoring channel access.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const guild = message.guild!;

    // Fetch jail settings from DB
    let jailRoleId: string | null = null;
    let jailChannelId: string | null = null;
    try {
      const { jailSettingsTable } = await import("@workspace/db/schema");
      const [row] = await db.select().from(jailSettingsTable).where(eq(jailSettingsTable.guildId, guild.id)).limit(1);
      jailRoleId = row?.jailRoleId ?? null;
      jailChannelId = row?.jailChannelId ?? null;
    } catch {}

    // 1. Remove Jailed role
    if (jailRoleId && member.roles.cache.has(jailRoleId)) {
      const jailRole = guild.roles.cache.get(jailRoleId)
        ?? await guild.roles.fetch(jailRoleId).catch(() => null);
      if (jailRole) await member.roles.remove(jailRole, "Unjailed").catch(() => null);
    }

    // 2. Clear all user-specific channel overwrites (restores normal channel access)
    const allTextChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText);
    for (const [, ch] of allTextChannels) {
      await (ch as TextChannel).permissionOverwrites.delete(member).catch(() => null);
    }

    // 3. Remove user-specific overwrite from jail channel too (no longer needs special access)
    if (jailChannelId) {
      const jailCh = guild.channels.cache.get(jailChannelId) as TextChannel | undefined;
      if (jailCh) await jailCh.permissionOverwrites.delete(member).catch(() => null);
    }

    // 4. Restore roles that were stripped at jail-time (if still in cache)
    const backupKey = `${guild.id}:${member.id}`;
    const backedUpRoles = jailRoleBackupStore.get(backupKey);
    if (backedUpRoles?.length) {
      const rolesToRestore = backedUpRoles
        .map((id) => guild.roles.cache.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined && r.id !== jailRoleId);
      if (rolesToRestore.length) {
        await member.roles.add(rolesToRestore, "Released from jail — restoring roles").catch(() => null);
      }
      jailRoleBackupStore.delete(backupKey);
    }

    await message.reply({ embeds: [successEmbed(`✅  **${member.user.tag}** has been released from jail and their access has been restored.`)] });
  },
});

// ── setprefix ─────────────────────────────────────────────────────────────────

register({
  name: "setprefix",
  description: "Changes the bot's command prefix for this server.",
  usage: "<prefix>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a prefix (e.g., `!`, `?`, `.`).")] });
    const newPrefix = args[0];
    if (newPrefix.length > 5) return void message.reply({ embeds: [errorEmbed("Prefix must be 5 characters or less.")] });
    const guildId = message.guild!.id;
    try {
      await db.insert(welcomeSettingsTable)
        .values({ guildId, guildPrefix: newPrefix })
        .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { guildPrefix: newPrefix, updatedAt: new Date() } });
      guildPrefixes.set(guildId, newPrefix);
      await message.reply({ embeds: [successEmbed(`Server prefix changed to \`${newPrefix}\`. All commands now use \`${newPrefix}<command>\`.`)] });
    } catch (err) {
      logger.error({ err }, "Failed to save prefix");
      await message.reply({ embeds: [errorEmbed("Failed to save the prefix. Please try again.")] });
    }
  },
});

// ── alias ─────────────────────────────────────────────────────────────────────

const aliasStore = new Map<string, string>();

register({
  name: "alias",
  description: "Manage command aliases.",
  usage: "add <command> <alias> | remove <alias> | list",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}alias add <command> <alias>\` or \`${PREFIX}alias remove <alias>\` or \`${PREFIX}alias list\``)] });
    
    const action = args[0].toLowerCase();
    
    if (action === "add") {
      if (args.length < 3) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}alias add <command> <alias>\``)] });
      const cmdName = args[1].toLowerCase();
      const aliasName = args[2].toLowerCase();
      const cmd = commands.get(cmdName);
      if (!cmd) return void message.reply({ embeds: [errorEmbed(`Command \`${cmdName}\` not found.`)] });
      commands.set(aliasName, cmd);
      aliasStore.set(aliasName, cmdName);
      await message.reply({ embeds: [successEmbed(`✅ Alias \`${PREFIX}${aliasName}\` added for \`${PREFIX}${cmdName}\`.`)] });
    } else if (action === "remove") {
      if (!args[1]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}alias remove <alias>\``)] });
      const aliasName = args[1].toLowerCase();
      const target = aliasStore.get(aliasName);
      if (!target) return void message.reply({ embeds: [errorEmbed(`Alias \`${aliasName}\` not found.`)] });
      commands.delete(aliasName);
      aliasStore.delete(aliasName);
      await message.reply({ embeds: [successEmbed(`❌ Alias \`${PREFIX}${aliasName}\` removed.`)] });
    } else if (action === "list") {
      if (aliasStore.size === 0) return void message.reply({ embeds: [errorEmbed("No aliases created yet.")] });
      const list = [...aliasStore.entries()].map(([alias, cmd]) => `\`${PREFIX}${alias}\` → \`${PREFIX}${cmd}\``).join("\n");
      await message.reply({ embeds: [infoEmbed("📋  Aliases").setDescription(list)] });
    } else {
      await message.reply({ embeds: [errorEmbed(`Unknown action. Use \`add\`, \`remove\`, or \`list\`.`)] });
    }
  },
});

// ── setbooster ────────────────────────────────────────────────────────────────

register({
  name: "setbooster",
  description: "Sets the booster announcements channel.",
  usage: "<#channel>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}setbooster <#channel>\``)] });
    const chId = args[0].match(/\d{17,19}/)?.[0];
    const channel = chId ? message.guild!.channels.cache.get(chId) : null;
    if (!channel?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid text channel.")] });
    try {
      await db.insert(welcomeSettingsTable)
        .values({ guildId: message.guild!.id, boosterChannelId: channel.id })
        .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { boosterChannelId: channel.id, updatedAt: new Date() } });
    } catch (err) {
      logger.error({ err }, "Failed to save booster channel");
    }
    await message.reply({ embeds: [successEmbed(`Booster announcement channel set to ${channel}.`)] });
  },
});

// ── setlogchannel ─────────────────────────────────────────────────────────────

register({
  name: "setlogchannel",
  aliases: ["setlog", "setlogs"],
  description: "Sets the event logs channel (message edits, deletes, reactions, channel changes).",
  usage: "<#channel>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}setlogchannel <#channel>\``)] });
    const chId = args[0].match(/\d{17,19}/)?.[0];
    const channel = chId ? message.guild!.channels.cache.get(chId) : null;
    if (!channel?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid text channel.")] });
    try {
      await db.insert(welcomeSettingsTable)
        .values({ guildId: message.guild!.id, eventLogChannelId: channel.id })
        .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { eventLogChannelId: channel.id, updatedAt: new Date() } });
    } catch (err) {
      logger.error({ err }, "Failed to save log channel");
    }
    await message.reply({ embeds: [successEmbed(`Log channel set to ${channel}. All events (message edits/deletes, reactions, channel changes) will be posted there.`)] });
  },
});

// ── setvcchannel ──────────────────────────────────────────────────────────────

register({
  name: "setvcchannel",
  aliases: ["setvc"],
  description: "Sets the voice channel activity logs channel.",
  usage: "<#channel>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}setvcchannel <#channel>\``)] });
    const chId = args[0].match(/\d{17,19}/)?.[0];
    const channel = chId ? message.guild!.channels.cache.get(chId) : null;
    if (!channel?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid text channel.")] });
    try {
      await db.insert(welcomeSettingsTable)
        .values({ guildId: message.guild!.id, vcLogChannelId: channel.id })
        .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { vcLogChannelId: channel.id, updatedAt: new Date() } });
    } catch (err) {
      logger.error({ err }, "Failed to save VC log channel");
    }
    await message.reply({ embeds: [successEmbed(`Voice log channel set to ${channel}. Voice join/leave/switch events will be logged there.`)] });
  },
});

// ── rolecreate ────────────────────────────────────────────────────────────────

register({
  name: "rolecreate",
  aliases: ["cr", "mkrole"],
  description: "Creates a new role with an interactive permission picker and color picker.",
  usage: "<name>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a role name.")] });
    const roleName = args.join(" ");

    // ── Permission options — filtered to only what the caller actually has ───────
    const ALL_PERM_OPTIONS: { label: string; value: string; description: string }[] = [
      { label: "Administrator",    value: "Administrator",    description: "Full server access" },
      { label: "Manage Server",    value: "ManageGuild",      description: "Edit server settings" },
      { label: "Manage Roles",     value: "ManageRoles",      description: "Create & edit roles" },
      { label: "Manage Channels",  value: "ManageChannels",   description: "Create & edit channels" },
      { label: "Kick Members",     value: "KickMembers",      description: "Kick members from server" },
      { label: "Ban Members",      value: "BanMembers",       description: "Ban members from server" },
      { label: "Manage Messages",  value: "ManageMessages",   description: "Delete & pin messages" },
      { label: "Manage Nicknames", value: "ManageNicknames",  description: "Change member nicknames" },
      { label: "View Audit Log",   value: "ViewAuditLog",     description: "View server audit log" },
      { label: "Mention Everyone", value: "MentionEveryone",  description: "Ping @everyone / @here" },
      { label: "Mute Members",     value: "MuteMembers",      description: "Mute members in voice" },
      { label: "Move Members",     value: "MoveMembers",      description: "Move members in voice" },
      { label: "Manage Webhooks",  value: "ManageWebhooks",   description: "Create & manage webhooks" },
      { label: "Manage Threads",   value: "ManageThreads",    description: "Manage threads" },
    ];
    const isOwner = message.author.id === BOT_OWNER_ID;
    // Owner sees everything; others only see permissions they personally hold
    const PERM_OPTIONS = [
      ...ALL_PERM_OPTIONS.filter(p => {
        if (isOwner) return true;
        const flag = PermissionFlagsBits[p.value as keyof typeof PermissionFlagsBits];
        return flag ? message.member!.permissions.has(flag) : false;
      }),
      { label: "No Permissions", value: "none", description: "Create role with no permissions" },
    ];
    if (PERM_OPTIONS.length === 1) {
      // Only "No Permissions" is available — the user has no assignable permissions
      return void message.reply({
        embeds: [errorEmbed("You don't have any assignable permissions to grant to a role.")],
      });
    }

    // ── Color options ──────────────────────────────────────────────────────────
    const COLOR_OPTIONS: { label: string; value: string; emoji: string }[] = [
      { label: "Default (no color)", value: "000000", emoji: "⬛" },
      { label: "Blurple",            value: "5865F2", emoji: "💜" },
      { label: "Red",                value: "ED4245", emoji: "🔴" },
      { label: "Orange",             value: "E67E22", emoji: "🟠" },
      { label: "Yellow",             value: "FEE75C", emoji: "🟡" },
      { label: "Green",              value: "57F287", emoji: "🟢" },
      { label: "Blue",               value: "3498DB", emoji: "🔵" },
      { label: "Purple",             value: "9B59B6", emoji: "🟣" },
      { label: "Pink",               value: "E91E8C", emoji: "🩷" },
      { label: "Teal",               value: "1ABC9C", emoji: "🩵" },
      { label: "Gold",               value: "F1C40F", emoji: "🌟" },
      { label: "White",              value: "FFFFFF", emoji: "⬜" },
    ];

    // ── Step 1: Permissions multi-select ──────────────────────────────────────
    const permMenu = new StringSelectMenuBuilder()
      .setCustomId("rolecreate_perms")
      .setPlaceholder("Select permissions (multi-select)…")
      .setMinValues(1)
      .setMaxValues(PERM_OPTIONS.length)
      .addOptions(
        PERM_OPTIONS.map(p =>
          new StringSelectMenuOptionBuilder().setLabel(p.label).setValue(p.value).setDescription(p.description)
        )
      );

    const permRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(permMenu);

    const step1Embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`🎭  Creating role: ${roleName}`)
      .setDescription("**Step 1 of 2** — Select the permissions for this role.\nYou can pick multiple. Choose **No Permissions** for a role with no special access.");

    const reply = await message.reply({ embeds: [step1Embed], components: [permRow] });

    try {
      // ── Collect permissions ──────────────────────────────────────────────────
      const permInteraction = await reply.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: i => i.user.id === message.author.id && i.customId === "rolecreate_perms",
        time: 60_000,
      });

      let selectedPerms = 0n;
      if (!permInteraction.values.includes("none")) {
        for (const val of permInteraction.values) {
          const flag = PermissionFlagsBits[val as keyof typeof PermissionFlagsBits];
          if (flag) selectedPerms |= flag;
        }
      }
      const permNames = permInteraction.values.includes("none")
        ? "None"
        : PERM_OPTIONS.filter(p => permInteraction.values.includes(p.value)).map(p => p.label).join(", ");

      // ── Step 2: Color select ───────────────────────────────────────────────
      const colorMenu = new StringSelectMenuBuilder()
        .setCustomId("rolecreate_color")
        .setPlaceholder("Choose a role color…")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          COLOR_OPTIONS.map(c =>
            new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.value).setEmoji(c.emoji)
          )
        );

      const colorRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(colorMenu);

      const step2Embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`🎭  Creating role: ${roleName}`)
        .setDescription(`**Step 2 of 2** — Choose a color for the role.\n\n✅ **Permissions:** ${permNames}`);

      await permInteraction.update({ embeds: [step2Embed], components: [colorRow] });

      // ── Collect color ────────────────────────────────────────────────────────
      const colorInteraction = await reply.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: i => i.user.id === message.author.id && i.customId === "rolecreate_color",
        time: 60_000,
      });

      const colorHex = colorInteraction.values[0];
      const colorInt = parseInt(colorHex, 16);
      const colorName = COLOR_OPTIONS.find(c => c.value === colorHex)?.label ?? colorHex;

      // ── Create the role ──────────────────────────────────────────────────────
      const newRole = await message.guild!.roles.create({
        name: roleName,
        color: colorInt,
        permissions: selectedPerms,
      });

      await colorInteraction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(colorInt || COLORS.primary)
            .setTitle("✅  Role Created")
            .addFields(
              { name: "Role", value: `${newRole}`, inline: true },
              { name: "Color", value: `#${colorHex}  (${colorName})`, inline: true },
              { name: "Permissions", value: permNames, inline: false },
            ),
        ],
        components: [],
      });
    } catch {
      await reply.edit({
        embeds: [errorEmbed("Role creation timed out or was cancelled.")],
        components: [],
      }).catch(() => null);
    }
  },
});

// ── dmall ─────────────────────────────────────────────────────────────────────

register({
  name: "dmall",
  description: "DMs all members in the server.",
  usage: "<message>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args.length) return void message.reply({ embeds: [errorEmbed("Provide a message.")] });
    const text = args.join(" ");
    const sent = await message.reply({ embeds: [infoEmbed("📨  Sending DMs...").setDescription("This may take a while.")] });
    const members = await message.guild!.members.fetch();
    let success = 0, failed = 0;
    for (const [, member] of members) {
      if (member.user.bot) continue;
      try {
        await member.user.send({
          embeds: [new EmbedBuilder().setColor(COLORS.primary)
            .setTitle(`📨  Message from ${message.guild!.name}`)
            .setDescription(text)
            .setFooter({ text: `Sent by ${message.author.tag}` })],
        });
        success++;
      } catch {
        failed++;
      }
    }
    await sent.edit({ embeds: [successEmbed(`✅ Sent to **${success}** members, **${failed}** failed.`)] });
  },
});

// ── sayembed ──────────────────────────────────────────────────────────────────

register({
  name: "sayembed",
  aliases: ["se", "embedsay"],
  description: "Sends a message as an embed.",
  usage: "<message>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    if (!args.length) return void message.reply({ embeds: [errorEmbed("Provide a message.")] });
    await message.delete().catch(() => null);
    const text = args.join(" ");
    await (message.channel as TextChannel).send({
      embeds: [new EmbedBuilder().setColor(COLORS.primary)
        .setDescription(text)
        .setFooter({ text: `Posted by ${message.author.tag}` })
        .setTimestamp()],
    });
  },
});

// ── massunban ─────────────────────────────────────────────────────────────────

register({
  name: "massunban",
  aliases: ["munban", "unbanall"],
  description: "Unbans all users from the server.",
  usage: "",
  category: "Moderation",
  async execute({ message }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    const sent = await message.reply({ embeds: [infoEmbed("🔄  Unbanning all users...").setDescription("This may take a while.")] });
    const bans = await message.guild!.bans.fetch();
    let success = 0;
    for (const [userId] of bans) {
      try {
        await message.guild!.bans.remove(userId);
        success++;
      } catch {}
    }
    await sent.edit({ embeds: [successEmbed(`Unbanned **${success}** users.`)] });
  },
});

// ── cleanup ───────────────────────────────────────────────────────────────────

register({
  name: "cleanup",
  aliases: ["botclean"],
  description: "Deletes messages from the bot.",
  usage: "[amount]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    const n = parseInt(args[0], 10) || 50;
    const msgs = await message.channel.messages.fetch({ limit: n });
    const botMsgs = msgs.filter((m) => m.author.id === message.client.user!.id);
    if (botMsgs.size === 0) return void message.reply({ embeds: [errorEmbed("No bot messages found.")] });
    await message.delete().catch(() => null);
    const deleted = await (message.channel as TextChannel).bulkDelete([...botMsgs.values()], true);
    const reply = await (message.channel as TextChannel).send({ embeds: [successEmbed(`Deleted **${deleted.size}** bot message(s).`)] });
    setTimeout(() => reply.delete().catch(() => null), 4000);
  },
});

// ── hide ──────────────────────────────────────────────────────────────────────

register({
  name: "hide",
  aliases: ["hideall"],
  description: "Hides a channel from @everyone.",
  usage: "[#channel]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    const chId = args[0]?.match(/\d{17,19}/)?.[0];
    const ch = (chId ? message.guild!.channels.cache.get(chId) : message.channel) as TextChannel;
    if (!ch?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid channel.")] });
    await ch.permissionOverwrites.edit(message.guild!.id, { ViewChannel: false });
    await message.reply({ embeds: [successEmbed(`🙈 Channel **${ch.name}** hidden.`)] });
  },
});

// ── reveal ────────────────────────────────────────────────────────────────────

register({
  name: "reveal",
  aliases: ["show", "unhide"],
  description: "Reveals a hidden channel to @everyone.",
  usage: "[#channel]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    const chId = args[0]?.match(/\d{17,19}/)?.[0];
    const ch = (chId ? message.guild!.channels.cache.get(chId) : message.channel) as TextChannel;
    if (!ch?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid channel.")] });
    await ch.permissionOverwrites.edit(message.guild!.id, { ViewChannel: null });
    await message.reply({ embeds: [successEmbed(`👁️ Channel **${ch.name}** revealed.`)] });
  },
});

// ── nsfw ──────────────────────────────────────────────────────────────────────

register({
  name: "nsfw",
  description: "Marks a channel as NSFW.",
  usage: "[#channel]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    const chId = args[0]?.match(/\d{17,19}/)?.[0];
    const ch = chId ? message.guild!.channels.cache.get(chId) : message.channel;
    if (!ch?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid channel.")] });
    await (ch as TextChannel).setNSFW(true);
    await message.reply({ embeds: [successEmbed(`Channel marked as **NSFW**.`)] });
  },
});

// ── topic ─────────────────────────────────────────────────────────────────────

register({
  name: "topic",
  aliases: ["settopic"],
  description: "Sets the channel topic.",
  usage: "<topic> | [#channel]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    if (!args.length) return void message.reply({ embeds: [errorEmbed("Provide a topic.")] });
    const chId = args[args.length - 1].match(/\d{17,19}/)?.[0];
    const topic = args.slice(0, chId ? -1 : args.length).join(" ");
    const ch = chId ? message.guild!.channels.cache.get(chId) : message.channel;
    if (!ch?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid channel.")] });
    await (ch as TextChannel).setTopic(topic.slice(0, 1024));
    await message.reply({ embeds: [successEmbed(`Topic set to: **${topic}**`)] });
  },
});

// ── pin ───────────────────────────────────────────────────────────────────────

register({
  name: "pin",
  description: "Pins a message in the current channel.",
  usage: "<message-id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    const msgId = args[0];
    if (!msgId) return void message.reply({ embeds: [errorEmbed("Provide a message ID.")] });
    try {
      const msg = await message.channel.messages.fetch(msgId);
      await msg.pin();
      await message.reply({ embeds: [successEmbed(`📌 Message pinned.`)] });
    } catch {
      await message.reply({ embeds: [errorEmbed("Could not find or pin that message.")] });
    }
  },
});

// ── unpin ─────────────────────────────────────────────────────────────────────

register({
  name: "unpin",
  description: "Unpins a message in the current channel.",
  usage: "<message-id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    const msgId = args[0];
    if (!msgId) return void message.reply({ embeds: [errorEmbed("Provide a message ID.")] });
    try {
      const msg = await message.channel.messages.fetch(msgId);
      await msg.unpin();
      await message.reply({ embeds: [successEmbed(`Message unpinned.`)] });
    } catch {
      await message.reply({ embeds: [errorEmbed("Could not find or unpin that message.")] });
    }
  },
});

// ── moveall ───────────────────────────────────────────────────────────────────

register({
  name: "moveall",
  description: "Moves all members from one voice channel to another.",
  usage: "<from-channel> <to-channel>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.MoveMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Move Members** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed("Provide source and destination channels.")] });
    const fromId = args[0].match(/\d{17,19}/)?.[0];
    const toId = args[1].match(/\d{17,19}/)?.[0];
    const fromCh = fromId ? (message.guild!.channels.cache.get(fromId) as VoiceChannel) : null;
    const toCh = toId ? (message.guild!.channels.cache.get(toId) as VoiceChannel) : null;
    if (!fromCh?.isVoiceBased() || !toCh?.isVoiceBased())
      return void message.reply({ embeds: [errorEmbed("Invalid voice channels.")] });
    let moved = 0;
    for (const [, member] of fromCh.members) {
      await member.voice.setChannel(toCh).catch(() => null);
      moved++;
    }
    await message.reply({ embeds: [successEmbed(`Moved **${moved}** members.`)] });
  },
});

// ── newusers ──────────────────────────────────────────────────────────────────

register({
  name: "newusers",
  aliases: ["newmembers"],
  description: "Lists the newest members in the server.",
  usage: "[amount]",
  category: "Moderation",
  async execute({ message, args }) {
    const n = parseInt(args[0], 10) || 10;
    const members = await message.guild!.members.fetch();
    const sorted = members.sort((a, b) => (b.joinedTimestamp || 0) - (a.joinedTimestamp || 0)).first(n);
    const list = sorted.map((m, i) => `**${i + 1}.** ${m.user.tag} — <t:${Math.floor((m.joinedTimestamp || 0) / 1000)}:R>`).join("\n");
    await message.reply({ embeds: [infoEmbed(`👤  Newest Members (${sorted.length})`).setDescription(list)] });
  },
});

// ── audit ─────────────────────────────────────────────────────────────────────

const AUDIT_ACTION_LABELS: Record<number, string> = {
  1: "Server Updated", 10: "Channel Created", 11: "Channel Updated", 12: "Channel Deleted",
  13: "Channel Overwrite Created", 14: "Channel Overwrite Updated", 15: "Channel Overwrite Deleted",
  20: "Member Kicked", 21: "Member Pruned", 22: "Member Banned", 23: "Member Unbanned",
  24: "Member Updated", 25: "Member Roles Updated", 26: "Member Moved (Voice)", 27: "Member Disconnected (Voice)", 28: "Bot Added",
  30: "Role Created", 31: "Role Updated", 32: "Role Deleted",
  40: "Invite Created", 41: "Invite Updated", 42: "Invite Deleted",
  50: "Webhook Created", 51: "Webhook Updated", 52: "Webhook Deleted",
  60: "Emoji Created", 61: "Emoji Updated", 62: "Emoji Deleted",
  72: "Messages Deleted", 73: "Messages Bulk Deleted", 74: "Message Pinned", 75: "Message Unpinned",
  80: "Integration Created", 81: "Integration Updated", 82: "Integration Deleted",
  83: "Stage Instance Created", 84: "Stage Instance Updated", 85: "Stage Instance Deleted",
  90: "Sticker Created", 91: "Sticker Updated", 92: "Sticker Deleted",
  100: "Event Created", 101: "Event Updated", 102: "Event Deleted",
  110: "Thread Created", 111: "Thread Updated", 112: "Thread Deleted",
  121: "App Command Permission Updated",
  140: "Soundboard Sound Created", 141: "Soundboard Sound Updated", 142: "Soundboard Sound Deleted",
  145: "AutoMod Rule Created", 146: "AutoMod Rule Updated", 147: "AutoMod Rule Deleted", 143: "AutoMod Alert Sent",
};

function auditActionLabel(action: number): string {
  return AUDIT_ACTION_LABELS[action] ?? `Action #${action}`;
}

function describeAuditChanges(changes: { key: string; old?: unknown; new?: unknown }[]): string {
  if (!changes.length) return "";
  return changes.slice(0, 5).map((c) => {
    const oldVal = c.old !== undefined && c.old !== null ? String(c.old).slice(0, 60) : "—";
    const newVal = c.new !== undefined && c.new !== null ? String(c.new).slice(0, 60) : "—";
    return `\`${c.key}\`: ${oldVal} → ${newVal}`;
  }).join("\n");
}

register({
  name: "audit",
  aliases: ["auditlog", "logs"],
  description: "Shows recent audit log entries with full detail.",
  usage: "[@user] [limit]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ViewAuditLog))
      return void message.reply({ embeds: [errorEmbed("You need **View Audit Log** permission.")] });

    // Optionally filter by user
    const userId = args[0]?.match(/\d{17,19}/)?.[0];
    const limit = Math.min(parseInt(args[userId ? 1 : 0] ?? "5", 10) || 5, 10);

    const fetchOpts: Parameters<typeof message.guild.fetchAuditLogs>[0] = { limit: limit + (userId ? 25 : 0) };
    const logs = await message.guild!.fetchAuditLogs(fetchOpts);

    let entries = [...logs.entries.values()];
    if (userId) entries = entries.filter((e) => e.executorId === userId || (e.targetId ?? "") === userId);
    entries = entries.slice(0, limit);

    if (!entries.length) return void message.reply({ embeds: [infoEmbed("📋  Audit Log").setDescription("No entries found.")] });

    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle("📋  Audit Log")
      .setTimestamp();

    for (const e of entries) {
      const actionName = auditActionLabel(e.action as number);
      const executor = e.executor ? `${e.executor.tag} (<@${e.executor.id}>)` : "Unknown";
      const target = e.targetId ? `<@${e.targetId}>` : "—";
      const ago = fmtDuration(Date.now() - e.createdTimestamp);
      const changes = (e.changes ?? []) as { key: string; old?: unknown; new?: unknown }[];
      const changesDesc = describeAuditChanges(changes);
      const reasonStr = e.reason ? `\nReason: ${e.reason}` : "";
      embed.addFields({
        name: `${actionName} — ${ago} ago`,
        value: `**By:** ${executor}\n**Target:** ${target}${reasonStr}${changesDesc ? `\n${changesDesc}` : ""}`.slice(0, 1024),
      });
    }

    await message.reply({ embeds: [embed] });
  },
});

// ── hardban ───────────────────────────────────────────────────────────────────

register({
  name: "hardban",
  aliases: ["hban"],
  description: "Bans a user and deletes their recent messages.",
  usage: "<@user|id> [reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    if (!member.bannable) return void message.reply({ embeds: [errorEmbed("I cannot ban this user.")] });
    const reason = args.slice(1).join(" ") || "Hardban";
    await member.ban({ deleteMessageSeconds: 604800, reason: `Hardban by ${message.author.tag}: ${reason}` });
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** hardbanned (messages deleted).\n**Reason:** ${reason}`)] });
  },
});

// ── hardbanlist ───────────────────────────────────────────────────────────────

register({
  name: "hardbanlist",
  description: "Shows all banned users.",
  usage: "",
  category: "Moderation",
  async execute({ message }) {
    const bans = await message.guild!.bans.fetch({ limit: 100 });
    if (bans.size === 0) return void message.reply({ embeds: [successEmbed("No bans on record.")] });
    const list = bans.first(10).map((b) => `${b.user.tag} — ${b.reason || "No reason"}`).join("\n");
    await message.reply({ embeds: [infoEmbed(`🔨  Banned Users (${bans.size})`).setDescription(list)] });
  },
});

// ── modhistory ────────────────────────────────────────────────────────────────

register({
  name: "modhistory",
  aliases: ["mhistory"],
  description: "Shows mod actions for a user.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const key = `${message.guild!.id}:${member.id}`;
    const warns = warningsStore.get(key) ?? [];
    const desc = warns.length === 0 ? "No history." : warns.slice(-5).map((w) => `**Case #${w.id}** — ${w.reason}`).join("\n");
    await message.reply({ embeds: [infoEmbed(`📜  History for ${member.user.tag}`).setDescription(desc)] });
  },
});

// ── history ───────────────────────────────────────────────────────────────────

register({
  name: "history",
  aliases: ["hist"],
  description: "Shows message history in the current channel.",
  usage: "[amount]",
  category: "Moderation",
  async execute({ message, args }) {
    const n = parseInt(args[0], 10) || 10;
    const msgs = await message.channel.messages.fetch({ limit: n });
    const list = msgs.last(5).map((m) => `**${m.author.tag}** — ${m.content.slice(0, 50)}`).join("\n");
    await message.reply({ embeds: [infoEmbed("📜  Recent Messages").setDescription(list)] });
  },
});

// ── picperms ──────────────────────────────────────────────────────────────────

register({
  name: "picperms",
  aliases: ["permpics"],
  description: "Shows permissions as a visual list.",
  usage: "[@user]",
  category: "Moderation",
  async execute({ message, args }) {
    const member = args[0] ? await resolveMember(message, args[0]) : (message.member as GuildMember);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const perms = member.permissionsIn(message.channel as TextChannel).toArray();
    const list = perms.slice(0, 15).map((p) => `✓ ${p}`).join("\n");
    await message.reply({ embeds: [infoEmbed(`🔐  ${member.displayName}'s Permissions`).setDescription(list || "None")] });
  },
});

// ── imute ─────────────────────────────────────────────────────────────────────

register({
  name: "imute",
  aliases: ["interruptmute"],
  description: "Mutes a member from interrupting messages.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ModerateMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Moderate Members** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    await member.timeout(3600000, "Interrupt mute");
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** interrupt muted for 1 hour.`)] });
  },
});

// ── rmute ─────────────────────────────────────────────────────────────────────

register({
  name: "rmute",
  aliases: ["reactionmute"],
  description: "Removes reaction permissions from a member.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    await (message.channel as TextChannel).permissionOverwrites.edit(member, { AddReactions: false });
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** can no longer add reactions.`)] });
  },
});

// ── chunkban ──────────────────────────────────────────────────────────────────

register({
  name: "chunkban",
  description: "Bans multiple users at once by their IDs.",
  usage: "<id1> <id2> ... [reason: <reason>]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    const reasonIdx = args.findIndex((a) => a.toLowerCase().startsWith("reason:"));
    const reason = reasonIdx !== -1 ? args.slice(reasonIdx).join(" ").replace(/^reason:\s*/i, "") : "Chunk ban";
    const ids = (reasonIdx !== -1 ? args.slice(0, reasonIdx) : args).filter((a) => /^\d{17,19}$/.test(a));
    if (ids.length === 0) return void message.reply({ embeds: [errorEmbed("Provide at least one user ID.")] });
    let success = 0;
    for (const id of ids) {
      try {
        await message.guild!.bans.create(id, { reason: `Chunkban by ${message.author.tag}: ${reason}` });
        success++;
      } catch {}
    }
    await message.reply({ embeds: [successEmbed(`Banned **${success}/${ids.length}** users.`)] });
  },
});

// ── temprole ──────────────────────────────────────────────────────────────────

register({
  name: "temprole",
  aliases: ["trole"],
  description: "Gives a member a temporary role.",
  usage: "<@user|id> <@role|id> <duration>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    if (args.length < 3) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}temprole <@user> <@role> <duration>\``)] });
    const member = await resolveMember(message, args[0]);
    const roleId = args[1].match(/\d{17,19}/)?.[0];
    const role = roleId ? message.guild!.roles.cache.get(roleId) : null;
    const ms = parseDuration(args[2]);
    if (!member || !role || !ms) return void message.reply({ embeds: [errorEmbed("Invalid user, role, or duration.")] });
    await member.roles.add(role);
    setTimeout(async () => {
      await member.roles.remove(role).catch(() => null);
    }, ms);
    await message.reply({ embeds: [successEmbed(`${member} given ${role} for ${fmtDuration(ms)}.`)] });
  },
});

// ── selfpurge ─────────────────────────────────────────────────────────────────

register({
  name: "selfpurge",
  aliases: ["selfclean"],
  description: "Deletes your own messages.",
  usage: "[amount]",
  category: "Moderation",
  async execute({ message, args }) {
    const n = parseInt(args[0], 10) || 50;
    const msgs = await message.channel.messages.fetch({ limit: n });
    const userMsgs = msgs.filter((m) => m.author.id === message.author.id);
    if (userMsgs.size === 0) return void message.reply({ embeds: [errorEmbed("No messages found.")] });
    await message.delete().catch(() => null);
    const deleted = await (message.channel as TextChannel).bulkDelete([...userMsgs.values()], true).catch(() => new Collection());
    const reply = await (message.channel as TextChannel).send({ embeds: [successEmbed(`Deleted **${deleted.size}** of your messages.`)] });
    setTimeout(() => reply.delete().catch(() => null), 4000);
  },
});

// ── protect ───────────────────────────────────────────────────────────────────

register({
  name: "protect",
  description: "Protects a member from moderation actions.",
  usage: "<@user|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    await message.reply({ embeds: [successEmbed(`🛡️ **${member.user.tag}** is now protected.`)] });
  },
});

// ── setup ─────────────────────────────────────────────────────────────────────

register({
  name: "setup",
  description: "Displays the bot setup guide.",
  usage: "",
  category: "Moderation",
  async execute({ message }) {
    await message.reply({
      embeds: [infoEmbed("⚙️  Bot Setup Guide")
        .setDescription("1. Run `-setwelcome <#channel>`\n2. Run `-setlogchannel <#channel>`\n3. Run `-editantinuke enable`\n4. Run `-setprefix <prefix>` (optional)")],
    });
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ LEVELING COMMANDS ═══════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

register({
  name: "rank",
  aliases: ["level", "xp"],
  description: "Shows the leveling rank of a member.",
  usage: "[@user]",
  category: "Leveling",
  async execute({ message, args }) {
    const member = args[0] ? await resolveMember(message, args[0]) : (message.member as GuildMember);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    try {
      const { db } = await import("@workspace/db");
      const { levelingProgressTable } = await import("@workspace/db/schema");
      const { eq, and } = await import("drizzle-orm");
      const [row] = await db.select().from(levelingProgressTable)
        .where(and(eq(levelingProgressTable.guildId, message.guild!.id), eq(levelingProgressTable.userId, member.id)));
      if (!row) return void message.reply({ embeds: [errorEmbed(`**${member.displayName}** has no XP yet.`)] });
      await message.reply({
        embeds: [
          infoEmbed(`⭐  ${member.displayName}'s Rank`)
            .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
            .addFields(
              { name: "Level", value: `\`${row.level}\``, inline: true },
              { name: "XP", value: `\`${row.xp}\``, inline: true }
            ),
        ],
      });
    } catch {
      await message.reply({ embeds: [errorEmbed("Leveling data unavailable.")] });
    }
  },
});

register({
  name: "leaderboard",
  aliases: ["lb", "top"],
  description: "Shows the top 10 members by XP.",
  usage: "",
  category: "Leveling",
  async execute({ message }) {
    try {
      const { db } = await import("@workspace/db");
      const { levelingProgressTable } = await import("@workspace/db/schema");
      const { eq, desc } = await import("drizzle-orm");
      const rows = await db.select().from(levelingProgressTable)
        .where(eq(levelingProgressTable.guildId, message.guild!.id))
        .orderBy(desc(levelingProgressTable.xp))
        .limit(10);
      if (!rows.length) return void message.reply({ embeds: [errorEmbed("No leveling data yet.")] });
      const desc2 = rows.map((r, i) => `**${i + 1}.** <@${r.userId}> — Level ${r.level} (${r.xp} XP)`).join("\n");
      await message.reply({ embeds: [infoEmbed(`🏆  ${message.guild!.name} Leaderboard`).setDescription(desc2)] });
    } catch {
      await message.reply({ embeds: [errorEmbed("Leveling data unavailable.")] });
    }
  },
});

// ── deletechannel ─────────────────────────────────────────────────────────────

register({
  name: "deletechannel",
  aliases: ["delchannel", "dc"],
  description: "Deletes the channel this command is used in.",
  usage: "[reason]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Channels** permission.")] });
    if (!message.guild?.members.me?.permissions.has(PermissionFlagsBits.ManageChannels))
      return void message.reply({ embeds: [errorEmbed("I don't have **Manage Channels** permission.")] });
    const reason = args.join(" ") || "No reason provided";
    await message.channel.send({ embeds: [warnEmbed(`🗑️ Deleting this channel in 3 seconds...\nReason: **${reason}**`)] })
      .catch(() => null);
    setTimeout(async () => {
      await message.channel.delete().catch(() => null);
    }, 3000);
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═════════════════════════ GIVEAWAY SYSTEM ═══════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

interface Giveaway {
  messageId: string;
  channelId: string;
  guildId: string;
  prize: string;
  winnersCount: number;
  endsAt: number;
  hostId: string;
  ended: boolean;
  winners: string[];
}
const giveawayStore = new Map<string, Giveaway>(); // messageId → Giveaway

async function endGiveaway(client: Client, giveaway: Giveaway) {
  giveaway.ended = true;
  try {
    const channel = await client.channels.fetch(giveaway.channelId) as TextChannel;
    const msg = await channel.messages.fetch(giveaway.messageId);
    const reaction = msg.reactions.cache.get("🎉");
    if (!reaction) { await channel.send({ embeds: [errorEmbed("No reactions found — no winner.")] }); return; }
    const users = await reaction.users.fetch();
    const eligible = [...users.values()].filter((u) => !u.bot);
    if (!eligible.length) { await channel.send({ embeds: [errorEmbed("No valid entries — no winner!")] }); return; }
    const shuffled = eligible.sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, giveaway.winnersCount);
    giveaway.winners = winners.map((w) => w.id);
    const mentions = winners.map((w) => `<@${w.id}>`).join(", ");
    await msg.edit({ embeds: [new EmbedBuilder().setColor(0xffd700).setTitle("🎉 GIVEAWAY ENDED 🎉").setDescription(`**${giveaway.prize}**\n\nWinner(s): ${mentions}`).setFooter({ text: `${giveaway.winnersCount} winner(s)` }).setTimestamp()] });
    await channel.send({ content: `🎊 Congratulations ${mentions}! You won **${giveaway.prize}**!` });
  } catch (err) { logger.error({ err }, "Failed to end giveaway"); }
}

register({
  name: "giveaway",
  aliases: ["gw", "give"],
  description: "Manage giveaways. Subcommands: start, end, reroll",
  usage: "start <duration> <winners> <prize> | end <messageId> | reroll <messageId>",
  category: "Giveaway",
  async execute({ message, args, client }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Server** permission.")] });
    const sub = args[0]?.toLowerCase();

    if (sub === "start") {
      if (args.length < 4) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}giveaway start <duration> <winners> <prize>\`\nExample: \`${PREFIX}giveaway start 1h 1 Nitro\``)] });
      const duration = parseDuration(args[1]);
      if (!duration) return void message.reply({ embeds: [errorEmbed("Invalid duration. Use: 30s, 5m, 1h, 1d")] });
      const winnersCount = Math.max(1, parseInt(args[2]) || 1);
      const prize = args.slice(3).join(" ");
      const endsAt = Date.now() + duration;
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle("🎉 GIVEAWAY 🎉")
        .setDescription(`**${prize}**\n\nReact with 🎉 to enter!\n\nEnds: <t:${Math.floor(endsAt / 1000)}:R>\nHosted by: ${message.author}`)
        .addFields({ name: "Winners", value: `${winnersCount}`, inline: true }, { name: "Ends", value: `<t:${Math.floor(endsAt / 1000)}:F>`, inline: true })
        .setFooter({ text: "Click 🎉 to enter" })
        .setTimestamp(endsAt);
      const msg = await (message.channel as TextChannel).send({ embeds: [embed] });
      await msg.react("🎉");
      const giveaway: Giveaway = { messageId: msg.id, channelId: msg.channel.id, guildId: message.guild!.id, prize, winnersCount, endsAt, hostId: message.author.id, ended: false, winners: [] };
      giveawayStore.set(msg.id, giveaway);
      setTimeout(() => endGiveaway(client, giveaway), duration);
      await message.delete().catch(() => null);
    } else if (sub === "end") {
      if (!args[1]) return void message.reply({ embeds: [errorEmbed("Provide the giveaway message ID.")] });
      const gw = giveawayStore.get(args[1]);
      if (!gw || gw.guildId !== message.guild!.id) return void message.reply({ embeds: [errorEmbed("Giveaway not found.")] });
      if (gw.ended) return void message.reply({ embeds: [errorEmbed("This giveaway already ended.")] });
      await endGiveaway(client, gw);
    } else if (sub === "reroll") {
      if (!args[1]) return void message.reply({ embeds: [errorEmbed("Provide the giveaway message ID.")] });
      const gw = giveawayStore.get(args[1]);
      if (!gw || gw.guildId !== message.guild!.id) return void message.reply({ embeds: [errorEmbed("Giveaway not found.")] });
      gw.ended = false;
      await endGiveaway(client, gw);
      await message.reply({ embeds: [successEmbed("Giveaway rerolled!")] });
    } else {
      await message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}giveaway start|end|reroll ...\``)] });
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ STATUS ROLE SYSTEM ══════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

// guildId → [{keyword, roleId}]
const statusRoleStore = new Map<string, { keyword: string; roleId: string }[]>();

export function getStatusRoles(guildId: string) { return statusRoleStore.get(guildId) ?? []; }

register({
  name: "statusrole",
  aliases: ["sr"],
  description: "Give a role when a member's status contains a keyword.",
  usage: "add <keyword> <@role> | remove <keyword> | list",
  category: "Utility",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    const sub = args[0]?.toLowerCase();
    const guildId = message.guild!.id;

    if (sub === "add") {
      if (args.length < 3) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}statusrole add <keyword> <@role>\``)] });
      const keyword = args[1].toLowerCase();
      const roleId = args[2].match(/\d{17,19}/)?.[0];
      const role = roleId ? message.guild!.roles.cache.get(roleId) : null;
      if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
      const list = statusRoleStore.get(guildId) ?? [];
      list.push({ keyword, roleId: role.id });
      statusRoleStore.set(guildId, list);
      await message.reply({ embeds: [successEmbed(`Members whose status contains **"${keyword}"** will receive ${role}.`)] });
    } else if (sub === "remove") {
      if (!args[1]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}statusrole remove <keyword>\``)] });
      const keyword = args[1].toLowerCase();
      const list = (statusRoleStore.get(guildId) ?? []).filter((s) => s.keyword !== keyword);
      statusRoleStore.set(guildId, list);
      await message.reply({ embeds: [successEmbed(`Removed status role for keyword **"${keyword}"**.`)] });
    } else if (sub === "list") {
      const list = statusRoleStore.get(guildId) ?? [];
      if (!list.length) return void message.reply({ embeds: [infoEmbed("No status roles set.")] });
      const desc = list.map((s) => `**"${s.keyword}"** → <@&${s.roleId}>`).join("\n");
      await message.reply({ embeds: [infoEmbed("Status Roles").setDescription(desc)] });
    } else {
      await message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}statusrole add|remove|list ...\``)] });
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ WORD FILTER COMMANDS ════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

// TOS-violating terms (Discord's own prohibited content categories)
export const TOS_WORDS = [
  "nigger","nigga","faggot","chink","spic","wetback","kike","gook","tranny","cunt",
  "csam","cp ","child porn","loli porn","nonce","pedo ","pedophile","jailbait",
  "ddos","dox ","doxx","swatting","grabify","ip grabber","stresser","booter",
  "rat link","discord nitro generator","free nitro hack","account token",
];

register({
  name: "filter",
  aliases: ["wordfilter", "wf"],
  description: "Manage custom blocked words.",
  usage: "add <word> | remove <word> | list | clear",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Server** permission.")] });
    const sub = args[0]?.toLowerCase();

    if (sub === "add") {
      if (!args[1]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}filter add <word>\``)] });
      const word = args[1].toLowerCase();
      try {
        const { db } = await import("@workspace/db");
        const { automodSettingsTable } = await import("@workspace/db/schema");
        const { eq, sql } = await import("drizzle-orm");
        await db.insert(automodSettingsTable)
          .values({ guildId: message.guild!.id, bannedWords: [word] })
          .onConflictDoUpdate({
            target: automodSettingsTable.guildId,
            set: { bannedWords: sql`array_append(${automodSettingsTable.bannedWords}, ${word})`, updatedAt: new Date() }
          });
        bannedWordsCache.delete(message.guild!.id);
        await message.reply({ embeds: [successEmbed(`Added **"${word}"** to the word filter. Messages containing it will be deleted.`)] });
      } catch (err) { await message.reply({ embeds: [errorEmbed("Failed to update filter.")] }); }
    } else if (sub === "remove") {
      if (!args[1]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}filter remove <word>\``)] });
      const word = args[1].toLowerCase();
      try {
        const { db } = await import("@workspace/db");
        const { automodSettingsTable } = await import("@workspace/db/schema");
        const { eq, sql } = await import("drizzle-orm");
        await db.insert(automodSettingsTable)
          .values({ guildId: message.guild!.id, bannedWords: [] })
          .onConflictDoUpdate({
            target: automodSettingsTable.guildId,
            set: { bannedWords: sql`array_remove(${automodSettingsTable.bannedWords}, ${word})`, updatedAt: new Date() }
          });
        bannedWordsCache.delete(message.guild!.id);
        await message.reply({ embeds: [successEmbed(`Removed **"${word}"** from the word filter.`)] });
      } catch { await message.reply({ embeds: [errorEmbed("Failed to update filter.")] }); }
    } else if (sub === "list") {
      try {
        const { db } = await import("@workspace/db");
        const { automodSettingsTable } = await import("@workspace/db/schema");
        const { eq } = await import("drizzle-orm");
        const [row] = await db.select().from(automodSettingsTable).where(eq(automodSettingsTable.guildId, message.guild!.id)).limit(1);
        const words = row?.bannedWords ?? [];
        if (!words.length) return void message.reply({ embeds: [infoEmbed("No custom words in the filter.")] });
        await message.reply({ embeds: [infoEmbed(`Custom Filter (${words.length} words)`).setDescription(words.map((w) => `\`${w}\``).join(", "))] });
      } catch { await message.reply({ embeds: [errorEmbed("Failed to load filter.")] }); }
    } else if (sub === "clear") {
      try {
        const { db } = await import("@workspace/db");
        const { automodSettingsTable } = await import("@workspace/db/schema");
        const { eq } = await import("drizzle-orm");
        await db.insert(automodSettingsTable)
          .values({ guildId: message.guild!.id, bannedWords: [] })
          .onConflictDoUpdate({ target: automodSettingsTable.guildId, set: { bannedWords: [], updatedAt: new Date() } });
        bannedWordsCache.delete(message.guild!.id);
        await message.reply({ embeds: [successEmbed("Word filter cleared.")] });
      } catch { await message.reply({ embeds: [errorEmbed("Failed to clear filter.")] }); }
    } else {
      await message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}filter add|remove|list|clear ...\``)] });
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ ROLE SHORTHAND ══════════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

register({
  name: "r",
  description: "Role shorthand. Subcommands: create, delete",
  usage: "create <name> [color] | delete <@role>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    const sub = args[0]?.toLowerCase();

    if (sub === "create") {
      if (!args[1]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}r create <name> [hex color]\``)] });
      const name = args.slice(1).join(" ").replace(/#[0-9a-fA-F]{6}$/, "").trim();
      const colorArg = args.find((a) => /^#?[0-9a-fA-F]{6}$/.test(a));
      const color = colorArg ? parseInt(colorArg.replace("#", ""), 16) : 0x2f3136;
      try {
        const role = await message.guild!.roles.create({ name, color });
        await message.reply({ embeds: [successEmbed(`Created role ${role}!`)] });
      } catch { await message.reply({ embeds: [errorEmbed("Could not create role.")] }); }
    } else if (sub === "delete") {
      if (!args[1]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}r delete <@role>\``)] });
      const roleId = args[1].match(/\d{17,19}/)?.[0];
      const role = roleId ? message.guild!.roles.cache.get(roleId) : null;
      if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
      await role.delete();
      await message.reply({ embeds: [successEmbed(`Deleted role **${role.name}**.`)] });
    } else {
      await message.reply({ embeds: [infoEmbed("Role Shorthand").setDescription(`\`${PREFIX}r create <name> [color]\` — Create a role\n\`${PREFIX}r delete <@role>\` — Delete a role`)] });
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ REACTION ROLES ══════════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

register({
  name: "reactionrole",
  aliases: ["reactrole", "rrole"],
  description: "Bind a role to a reaction on a message.",
  usage: "add <#channel> <messageId> <emoji> <@role> | remove <messageId> <emoji> | list",
  category: "Utility",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    const sub = args[0]?.toLowerCase();

    if (sub === "add") {
      if (args.length < 5) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}reactionrole add <#channel> <messageId> <emoji> <@role>\``)] });
      const chId = args[1].match(/\d{17,19}/)?.[0];
      const channel = chId ? message.guild!.channels.cache.get(chId) : null;
      if (!channel?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid channel.")] });
      const msgId = args[2];
      const emoji = args[3];
      const roleId = args[4].match(/\d{17,19}/)?.[0];
      const role = roleId ? message.guild!.roles.cache.get(roleId) : null;
      if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
      try {
        const targetMsg = await (channel as TextChannel).messages.fetch(msgId);
        await targetMsg.react(emoji);
        const { db } = await import("@workspace/db");
        const { reactionRolesTable } = await import("@workspace/db/schema");
        await db.insert(reactionRolesTable).values({
          guildId: message.guild!.id, channelId: channel.id, messageId: msgId,
          emoji, roleId: role.id, roleName: role.name,
        });
        await message.reply({ embeds: [successEmbed(`React with ${emoji} on that message to get ${role}!`)] });
      } catch (err) { await message.reply({ embeds: [errorEmbed("Failed. Make sure the message ID is correct.")] }); }
    } else if (sub === "remove") {
      if (args.length < 3) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}reactionrole remove <messageId> <emoji>\``)] });
      const msgId = args[1]; const emoji = args[2];
      try {
        const { db } = await import("@workspace/db");
        const { reactionRolesTable } = await import("@workspace/db/schema");
        const { and, eq } = await import("drizzle-orm");
        await db.delete(reactionRolesTable).where(and(eq(reactionRolesTable.guildId, message.guild!.id), eq(reactionRolesTable.messageId, msgId), eq(reactionRolesTable.emoji, emoji)));
        await message.reply({ embeds: [successEmbed("Reaction role removed.")] });
      } catch { await message.reply({ embeds: [errorEmbed("Failed to remove reaction role.")] }); }
    } else if (sub === "list") {
      try {
        const { db } = await import("@workspace/db");
        const { reactionRolesTable } = await import("@workspace/db/schema");
        const { eq } = await import("drizzle-orm");
        const rows = await db.select().from(reactionRolesTable).where(eq(reactionRolesTable.guildId, message.guild!.id));
        if (!rows.length) return void message.reply({ embeds: [infoEmbed("No reaction roles set up.")] });
        const desc = rows.map((r) => `${r.emoji} on msg \`${r.messageId}\` → <@&${r.roleId}>`).join("\n");
        await message.reply({ embeds: [infoEmbed(`Reaction Roles (${rows.length})`).setDescription(desc)] });
      } catch { await message.reply({ embeds: [errorEmbed("Failed to load reaction roles.")] }); }
    } else {
      await message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}reactionrole add|remove|list ...\``)] });
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ TICKET SYSTEM ═══════════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

// guildId → { managersRoleIds, openedCategoryId }
export const ticketStore = new Map<string, { managerRoles: string[]; openedCategoryId?: string }>();
// userId → channelId (open tickets)
export const openTickets = new Map<string, string>(); // `${guildId}:${userId}` → channelId

register({
  name: "ticket",
  aliases: ["tickets"],
  description: "Ticket system management.",
  usage: "setup | manager add/remove <@role> | close",
  category: "Utility",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Server** permission.")] });
    const sub = args[0]?.toLowerCase();

    if (sub === "setup") {
      try {
        const guild = message.guild!;
        // Create support category
        const supportCategory = await guild.channels.create({ name: "🎫 Support", type: ChannelType.GuildCategory });
        // Create opened tickets category
        const openedCategory = await guild.channels.create({ name: "📂 Opened Tickets", type: ChannelType.GuildCategory });
        // Create the create-ticket channel
        const ticketChannel = await guild.channels.create({
          name: "📬・create-ticket",
          type: ChannelType.GuildText,
          parent: supportCategory.id,
        });
        // Save category id
        const data = ticketStore.get(guild.id) ?? { managerRoles: [] };
        data.openedCategoryId = openedCategory.id;
        ticketStore.set(guild.id, data);
        // Send the ticket embed with button
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🎫 Support Tickets")
          .setDescription("Need help? Click the button below to open a private support ticket.\nOur team will assist you as soon as possible.")
          .setFooter({ text: guild.name });
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ticket_create").setLabel("📩 Create Ticket").setStyle(ButtonStyle.Primary)
        );
        await ticketChannel.send({ embeds: [embed], components: [row] });
        await message.reply({ embeds: [successEmbed(`Ticket system set up! Panel posted in ${ticketChannel}.\nCategory: ${supportCategory}\nTickets go to: ${openedCategory}`)] });
      } catch (err) { logger.error({ err }, "Ticket setup failed"); await message.reply({ embeds: [errorEmbed("Failed to set up ticket system.")] }); }
    } else if (sub === "manager") {
      const action = args[1]?.toLowerCase();
      if (!action || !["add", "remove"].includes(action) || !args[2])
        return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}ticket manager add/remove <@role>\``)] });
      const roleId = args[2].match(/\d{17,19}/)?.[0];
      const role = roleId ? message.guild!.roles.cache.get(roleId) : null;
      if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
      const data = ticketStore.get(message.guild!.id) ?? { managerRoles: [] };
      if (action === "add") {
        if (!data.managerRoles.includes(role.id)) data.managerRoles.push(role.id);
        await message.reply({ embeds: [successEmbed(`${role} can now manage tickets.`)] });
      } else {
        data.managerRoles = data.managerRoles.filter((r) => r !== role.id);
        await message.reply({ embeds: [successEmbed(`${role} removed from ticket managers.`)] });
      }
      ticketStore.set(message.guild!.id, data);
    } else if (sub === "close") {
      const key = [...openTickets.entries()].find(([, chId]) => chId === message.channel.id)?.[0];
      if (!key) return void message.reply({ embeds: [errorEmbed("This is not a ticket channel.")] });
      await message.reply({ embeds: [warnEmbed("Closing ticket in 5 seconds...")] });
      setTimeout(async () => { await message.channel.delete().catch(() => null); openTickets.delete(key); }, 5000);
    } else {
      await message.reply({ embeds: [infoEmbed("Ticket Commands").setDescription(
        `\`${PREFIX}ticket setup\` — Set up ticket panel\n\`${PREFIX}ticket manager add <@role>\` — Add ticket manager role\n\`${PREFIX}ticket manager remove <@role>\` — Remove manager role\n\`${PREFIX}ticket close\` — Close current ticket channel`
      )] });
    }
  },
});

// ── whitelist ─────────────────────────────────────────────────────────────────

register({
  name: "whitelist",
  description: "Whitelists a user or bot ID from AntiNuke detection.",
  usage: "<user_id>",
  category: "Security",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    const userId = args[0]?.match(/\d{17,20}/)?.[0];
    if (!userId) return void message.reply({ embeds: [errorEmbed("Provide a valid user/bot ID. Usage: `-whitelist <user_id>`")] });

    let targetName = userId;
    try {
      const user = await message.client.users.fetch(userId);
      targetName = user.tag ?? userId;
    } catch {}

    try {
      const existing = await db.select().from(antinukeWhitelistTable)
        .where(and(eq(antinukeWhitelistTable.guildId, message.guild!.id), eq(antinukeWhitelistTable.targetId, userId)))
        .limit(1);
      if (existing.length > 0) {
        return void message.reply({ embeds: [warnEmbed(`\`${userId}\` is already on the AntiNuke whitelist.`)] });
      }
      await db.insert(antinukeWhitelistTable).values({
        guildId: message.guild!.id,
        targetId: userId,
        targetType: "user",
        targetName,
      });
      await message.reply({ embeds: [successEmbed(`**${targetName}** (\`${userId}\`) has been whitelisted from AntiNuke.`)] });
    } catch (err) {
      logger.error({ err }, "Failed to add antinuke whitelist entry");
      await message.reply({ embeds: [errorEmbed("Failed to add to whitelist.")] });
    }
  },
});

// ── unwhitelist ───────────────────────────────────────────────────────────────

register({
  name: "unwhitelist",
  description: "Removes a user or bot from the AntiNuke whitelist.",
  usage: "<user_id>",
  category: "Security",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    const userId = args[0]?.match(/\d{17,20}/)?.[0];
    if (!userId) return void message.reply({ embeds: [errorEmbed("Provide a valid user/bot ID.")] });

    try {
      const deleted = await db.delete(antinukeWhitelistTable)
        .where(and(eq(antinukeWhitelistTable.guildId, message.guild!.id), eq(antinukeWhitelistTable.targetId, userId)))
        .returning();
      if (deleted.length === 0) {
        return void message.reply({ embeds: [warnEmbed(`ID \`${userId}\` was not found on the whitelist.`)] });
      }
      await message.reply({ embeds: [successEmbed(`\`${userId}\` has been removed from the AntiNuke whitelist.`)] });
    } catch (err) {
      logger.error({ err }, "Failed to remove antinuke whitelist entry");
      await message.reply({ embeds: [errorEmbed("Failed to remove from whitelist.")] });
    }
  },
});

// ── whitelistlist ─────────────────────────────────────────────────────────────

register({
  name: "whitelistlist",
  aliases: ["wl"],
  description: "Shows all whitelisted users/bots for AntiNuke.",
  usage: "",
  category: "Security",
  async execute({ message }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });

    try {
      const entries = await db.select().from(antinukeWhitelistTable)
        .where(eq(antinukeWhitelistTable.guildId, message.guild!.id));
      if (entries.length === 0) {
        return void message.reply({ embeds: [infoEmbed("AntiNuke Whitelist").setDescription("No users are whitelisted.")] });
      }
      const list = entries.map((e, i) => `**${i + 1}.** ${e.targetName} (\`${e.targetId}\`)`).join("\n");
      await message.reply({ embeds: [infoEmbed("AntiNuke Whitelist").setDescription(list)] });
    } catch (err) {
      logger.error({ err }, "Failed to fetch antinuke whitelist");
      await message.reply({ embeds: [errorEmbed("Failed to fetch whitelist.")] });
    }
  },
});

// ── editantinuke ──────────────────────────────────────────────────────────────

register({
  name: "editantinuke",
  aliases: ["setan"],
  description: "Enables or disables the AntiNuke system.",
  usage: "enable | disable",
  category: "Security",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    const action = args[0]?.toLowerCase();
    if (action !== "enable" && action !== "disable")
      return void message.reply({ embeds: [errorEmbed("Usage: `-editantinuke enable` or `-editantinuke disable`")] });
    const enabled = action === "enable";
    try {
      await db.insert(antinukeSettingsTable)
        .values({ guildId: message.guild!.id, enabled })
        .onConflictDoUpdate({ target: antinukeSettingsTable.guildId, set: { enabled, updatedAt: new Date() } });
      await message.reply({ embeds: [successEmbed(`AntiNuke has been **${enabled ? "enabled" : "disabled"}**.`)] });
    } catch (err) {
      logger.error({ err }, "Failed to update antinuke setting");
      await message.reply({ embeds: [errorEmbed("Failed to update AntiNuke.")] });
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ NEW COMMANDS ════════════════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

// ── prefix set ───────────────────────────────────────────────────────────────
register({
  name: "prefix",
  description: "Set the bot prefix for this server.",
  usage: "set <prefix>",
  category: "Setup",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Server** permission.")] });
    if (args[0]?.toLowerCase() !== "set" || !args[1])
      return void message.reply({ embeds: [errorEmbed("Usage: `-prefix set <prefix>`")] });
    const newPrefix = args[1];
    if (newPrefix.length > 5) return void message.reply({ embeds: [errorEmbed("Prefix must be 5 characters or fewer.")] });
    const guildId = message.guild!.id;
    await db.insert(welcomeSettingsTable)
      .values({ guildId, guildPrefix: newPrefix })
      .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { guildPrefix: newPrefix, updatedAt: new Date() } });
    guildPrefixes.set(guildId, newPrefix);
    await message.reply({ embeds: [successEmbed(`Prefix for this server is now \`${newPrefix}\``)] });
  },
});

// ── pingonjoin ────────────────────────────────────────────────────────────────
register({
  name: "pingonjoin",
  description: "Pings new members in a channel when they join.",
  usage: "<#channel>",
  category: "Setup",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Server** permission.")] });
    const channelId = args[0]?.match(/\d{17,19}/)?.[0];
    if (!channelId) return void message.reply({ embeds: [errorEmbed("Usage: `-pingonjoin <#channel>`")] });
    const guildId = message.guild!.id;
    await db.insert(welcomeSettingsTable)
      .values({ guildId, pingOnJoinChannelId: channelId })
      .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { pingOnJoinChannelId: channelId, updatedAt: new Date() } });
    await message.reply({ embeds: [successEmbed(`New members will be pinged in <#${channelId}> when they join.`)] });
  },
});

// ── setwelcome (updated) ──────────────────────────────────────────────────────
register({
  name: "setwelcome",
  description: "Set the welcome channel. The bot will ping and greet new members there.",
  usage: "<#channel>",
  category: "Setup",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Server** permission.")] });
    const channelId = args[0]?.match(/\d{17,19}/)?.[0];
    if (!channelId) return void message.reply({ embeds: [errorEmbed("Usage: `-setwelcome <#channel>`")] });
    const guildId = message.guild!.id;
    await db.insert(welcomeSettingsTable)
      .values({ guildId, welcomeChannelId: channelId, welcomeEnabled: true })
      .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { welcomeChannelId: channelId, welcomeEnabled: true, updatedAt: new Date() } });
    await message.reply({ embeds: [successEmbed(`Welcome channel set to <#${channelId}>. New members will be pinged there.`)] });
  },
});

// ── autorole ─────────────────────────────────────────────────────────────────
register({
  name: "autorole",
  description: "Automatically give a role to all new members when they join.",
  usage: "<@role | roleId> | off",
  category: "Setup",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    const guildId = message.guild!.id;
    if (args[0]?.toLowerCase() === "off") {
      await db.insert(welcomeSettingsTable)
        .values({ guildId, autoRoleId: null })
        .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { autoRoleId: null, updatedAt: new Date() } });
      return void message.reply({ embeds: [successEmbed("Autorole disabled.")] });
    }
    const roleId = args[0]?.match(/\d{17,19}/)?.[0];
    if (!roleId) return void message.reply({ embeds: [errorEmbed("Usage: `-autorole <@role>` or `-autorole off`")] });
    const role = message.guild!.roles.cache.get(roleId);
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
    await db.insert(welcomeSettingsTable)
      .values({ guildId, autoRoleId: roleId })
      .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { autoRoleId: roleId, updatedAt: new Date() } });
    await message.reply({ embeds: [successEmbed(`New members will automatically receive **${role.name}**.`)] });
  },
});

// ── vanity ────────────────────────────────────────────────────────────────────
register({
  name: "vanity",
  description: "Give a role to members who have the server vanity URL in their status.",
  usage: "set <vanity_code> <@role>",
  category: "Setup",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Server** permission.")] });
    if (args[0]?.toLowerCase() !== "set" || !args[1] || !args[2])
      return void message.reply({ embeds: [errorEmbed("Usage: `-vanity set <vanity_code> <@role>`")] });
    const vanityCode = args[1].replace(/\//g, "").toLowerCase();
    const roleId = args[2]?.match(/\d{17,19}/)?.[0];
    if (!roleId) return void message.reply({ embeds: [errorEmbed("Please mention a valid role.")] });
    const role = message.guild!.roles.cache.get(roleId);
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
    const guildId = message.guild!.id;
    await db.insert(welcomeSettingsTable)
      .values({ guildId, vanityCode, vanityRoleId: roleId })
      .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { vanityCode, vanityRoleId: roleId, updatedAt: new Date() } });
    await message.reply({ embeds: [successEmbed(`Members with \`/${vanityCode}\` in their status will receive **${role.name}**.`)] });
  },
});

// ── servers (bot owner only) ──────────────────────────────────────────────────
register({
  name: "servers",
  aliases: ["guilds"],
  description: "List all servers the bot is in with detailed info. (Bot owner only)",
  usage: "",
  category: "Owner",
  async execute({ message, client }) {
    if (message.author.id !== BOT_OWNER_ID)
      return void message.reply({ embeds: [errorEmbed("🔒 This command is restricted to the **bot owner** only.")] });

    const guilds = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
    const totalMembers = guilds.reduce((acc, g) => acc + g.memberCount, 0);
    const totalBots = guilds.reduce((acc, g) => acc + g.members.cache.filter(m => m.user.bot).size, 0);

    // Overview embed
    const overviewEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🌐  Bot Servers — ${guilds.length} total`)
      .setDescription(
        guilds.map((g, i) => {
          const botCount = g.members.cache.filter(m => m.user.bot).size;
          const humanCount = g.memberCount - botCount;
          return `\`${String(i + 1).padStart(2, "0")}.\` **${g.name}**\n` +
            `　　\`${g.id}\`  •  👥 ${humanCount.toLocaleString()} humans  •  🤖 ${botCount} bots`;
        }).join("\n\n") || "No servers."
      )
      .addFields(
        { name: "Total Members", value: totalMembers.toLocaleString(), inline: true },
        { name: "Total Humans", value: (totalMembers - totalBots).toLocaleString(), inline: true },
        { name: "Total Bots", value: totalBots.toString(), inline: true },
      )
      .setFooter({ text: `Sorted by member count  •  Bot Owner only` })
      .setTimestamp();

    // Select menu for per-server detail
    const menu = new StringSelectMenuBuilder()
      .setCustomId("servers_detail")
      .setPlaceholder("Select a server for more details…")
      .addOptions(
        guilds.slice(0, 25).map(g =>
          new StringSelectMenuOptionBuilder()
            .setLabel(g.name.slice(0, 100))
            .setValue(g.id)
            .setDescription(`${g.memberCount.toLocaleString()} members  •  ${g.id}`)
        )
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    const reply = await message.reply({ embeds: [overviewEmbed], components: [row] });

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: i => i.user.id === message.author.id,
      time: 90_000,
    });

    collector.on("collect", async interaction => {
      const guildId = interaction.values[0];
      const g = client.guilds.cache.get(guildId);
      if (!g) return void interaction.reply({ content: "Guild not found.", ephemeral: true });

      const owner = await g.fetchOwner().catch(() => null);
      const botCount = g.members.cache.filter(m => m.user.bot).size;
      const createdAgo = Math.floor((Date.now() - g.createdTimestamp) / 86_400_000);
      const botJoined = g.members.cache.get(client.user!.id)?.joinedAt;

      // Generate an invite from the first available text channel
      const inviteChannel = g.channels.cache
        .filter(c => c.type === ChannelType.GuildText && c.permissionsFor(g.members.me!)?.has(PermissionFlagsBits.CreateInstantInvite))
        .first() as TextChannel | undefined;
      const invite = inviteChannel
        ? await g.invites.create(inviteChannel, { maxAge: 0, maxUses: 0, reason: "Bot owner -servers command" }).catch(() => null)
        : null;

      const detailEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🔍  ${g.name}`)
        .setThumbnail(g.iconURL({ size: 256 }) ?? null)
        .addFields(
          { name: "Server ID", value: `\`${g.id}\``, inline: true },
          { name: "Owner", value: owner ? `${owner.user.tag}\n\`${owner.id}\`` : "Unknown", inline: true },
          { name: "Region", value: g.preferredLocale, inline: true },
          { name: "Members", value: `👥 ${(g.memberCount - botCount).toLocaleString()} humans\n🤖 ${botCount} bots`, inline: true },
          { name: "Channels", value: `${g.channels.cache.size} total`, inline: true },
          { name: "Roles", value: `${g.roles.cache.size}`, inline: true },
          { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R> (${createdAgo}d ago)`, inline: true },
          { name: "Bot Joined", value: botJoined ? `<t:${Math.floor(botJoined.getTime() / 1000)}:R>` : "Unknown", inline: true },
          { name: "Verification", value: g.verificationLevel.toString(), inline: true },
          { name: "Invite Link", value: invite ? `[Join ${g.name}](${invite.url})\n\`${invite.url}\`` : "Unable to create invite (missing permission)", inline: false },
        )
        .setFooter({ text: "← Back: select another server" });

      await interaction.update({ embeds: [detailEmbed], components: [row] });
    });

    collector.on("end", async () => {
      const disabled = new StringSelectMenuBuilder()
        .setCustomId("servers_detail_disabled")
        .setPlaceholder("Session expired — run -servers again")
        .setDisabled(true)
        .addOptions(new StringSelectMenuOptionBuilder().setLabel("Expired").setValue("expired"));
      await reply.edit({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(disabled)] }).catch(() => null);
    });
  },
});

// ── owner (bot owner help menu) ───────────────────────────────────────────────
register({
  name: "owner",
  aliases: ["botowner", "ownerhelp"],
  description: "Owner-only info and control panel for the bot. (Bot owner only)",
  usage: "",
  category: "Owner",
  async execute({ message, client }) {
    if (message.author.id !== BOT_OWNER_ID)
      return void message.reply({ embeds: [errorEmbed("🔒 This command is restricted to the **bot owner** only.")] });

    const guilds = [...client.guilds.cache.values()];
    const totalMembers = guilds.reduce((acc, g) => acc + g.memberCount, 0);
    const uptimeMs = client.uptime ?? 0;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const ping = client.ws.ping;

    const sections: Record<string, { name: string; value: string }[]> = {
      "📊 Bot Stats": [
        { name: "Uptime", value: uptimeStr },
        { name: "Latency", value: `${ping}ms` },
        { name: "Memory", value: `${memMB} MB RSS` },
        { name: "Servers", value: `${guilds.length}` },
        { name: "Total Members", value: totalMembers.toLocaleString() },
        { name: "Node.js", value: process.version },
      ],
      "🔧 Owner Commands": [
        { name: "`-servers`", value: "List all servers the bot is in, with a select menu for per-server details." },
        { name: "`-owner`", value: "This menu — bot stats, owner commands, and config info." },
        { name: "`-save server`", value: "Save the current server's full structure (channels, categories, permissions). **Server owner only.**" },
        { name: "`-restore server`", value: "Restore the server from its last save, auto-ban the nuker, and delete their messages. **Server owner only.**" },
        { name: "`-server create {number}`", value: "Save the current server layout to a numbered slot (1–999). **Server owner only.**" },
        { name: "`-server dump {number}`", value: "Apply a saved server template from a numbered slot into the current server. **Server owner only.**" },
      ],
      "💾 Server Backup": [
        { name: "How it works", value: "Use `-save server` to snapshot your server at any time. If anything gets nuked or deleted, `-restore server` will rebuild missing channels, ban the attacker, and wipe their messages automatically." },
        { name: "Templates", value: "Use `-server create {number}` to store a server layout, then `-server dump {number}` to copy that layout into any server you own." },
        { name: "Who can use it", value: "Only the **server owner** of each server can run these commands — admins cannot." },
        { name: "Tip", value: "Run `-save server` whenever you make changes to your server so the backup stays current." },
      ],
      "⚙️ Configuration": [
        { name: "Bot Prefix", value: `\`${PREFIX}\` (default, per-server overrides supported)` },
        { name: "Owner ID", value: `\`${BOT_OWNER_ID}\`` },
        { name: "Bot User", value: `${client.user?.tag ?? "Unknown"} (\`${client.user?.id}\`)` },
        { name: "Invite Link", value: `[Add to server](https://discord.com/oauth2/authorize?client_id=${client.user?.id}&permissions=8&scope=bot)` },
      ],
      "🛡️ Safety Notes": [
        { name: "Anti-Nuke", value: "Protects servers from mass channel/role deletions and member kicks. Enable per-server via `-antinuke`." },
        { name: "Anti-Raid", value: "Rate-limits mass joins. Enable per-server via `-antiraid`." },
        { name: "Auto-Mod", value: "Filters bad words, excessive mentions, and link spam. Configure via `-automod`." },
        { name: "Whitelist", value: "Use `-whitelist @user` to exempt users from auto-mod in any server." },
      ],
    };

    const menu = new StringSelectMenuBuilder()
      .setCustomId("owner_section")
      .setPlaceholder("Choose a section…")
      .addOptions(
        Object.keys(sections).map(label =>
          new StringSelectMenuOptionBuilder()
            .setLabel(label.replace(/^\S+\s/, ""))
            .setValue(label)
            .setEmoji(label.split(" ")[0])
        )
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    const homeEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`⚡  Owner Control Panel`)
      .setDescription(
        `Welcome, <@${message.author.id}>.\n\n` +
        `**Bot:** ${client.user?.tag}  •  **Uptime:** ${uptimeStr}  •  **Ping:** ${ping}ms\n` +
        `**Servers:** ${guilds.length}  •  **Members:** ${totalMembers.toLocaleString()}\n\n` +
        `Use the menu below to browse owner info and commands.`
      )
      .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
      .setFooter({ text: `Bot Owner only  •  ${message.author.tag}` })
      .setTimestamp();

    const reply = await message.reply({ embeds: [homeEmbed], components: [row] });

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: i => {
        if (i.user.id !== BOT_OWNER_ID) {
          i.reply({ content: "🔒 Only the bot owner can interact with this menu.", ephemeral: true }).catch(() => null);
          return false;
        }
        return true;
      },
      time: 90_000,
    });

    collector.on("collect", async interaction => {
      const selected = interaction.values[0];
      const fields = sections[selected] ?? [];

      const sectionEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(selected)
        .addFields(fields.map(f => ({ name: f.name, value: f.value, inline: false })))
        .setFooter({ text: "← Back: select another section" });

      await interaction.update({ embeds: [sectionEmbed], components: [row] });
    });

    collector.on("end", async () => {
      const disabled = new StringSelectMenuBuilder()
        .setCustomId("owner_section_disabled")
        .setPlaceholder("Session expired — run -owner again")
        .setDisabled(true)
        .addOptions(new StringSelectMenuOptionBuilder().setLabel("Expired").setValue("expired"));
      await reply.edit({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(disabled)] }).catch(() => null);
    });
  },
});

// ── emoji steal ───────────────────────────────────────────────────────────────
register({
  name: "emoji",
  description: "Steal one or more emojis and add them to this server.",
  usage: "steal <emoji> [emoji2] ...",
  category: "Moderation",
  aliases: ["emojisteal", "steal"],
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuildExpressions))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Expressions** permission.")] });
    if (args[0]?.toLowerCase() !== "steal" || args.length < 2)
      return void message.reply({ embeds: [errorEmbed("Usage: `-emoji steal <emoji> [emoji2] ...`")] });
    const emojiArgs = args.slice(1);
    const results: string[] = [];
    for (const raw of emojiArgs) {
      const match = raw.match(/<a?:(\w+):(\d+)>/);
      if (!match) { results.push(`❌ \`${raw}\` — not a custom emoji`); continue; }
      const [, name, id] = match;
      const animated = raw.startsWith("<a:");
      const ext = animated ? "gif" : "png";
      const url = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
      try {
        const created = await message.guild!.emojis.create({ attachment: url, name });
        results.push(`✅ Added ${created} \`${created.name}\``);
      } catch {
        results.push(`❌ Failed to add \`${name}\``);
      }
    }
    await message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Emoji Steal Results").setDescription(results.join("\n"))] });
  },
});

// ── role restore ──────────────────────────────────────────────────────────────
register({
  name: "rolerestore",
  description: "Restore saved roles to a member (from before they left).",
  usage: "<@user>",
  category: "Moderation",
  aliases: ["role restore"],
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("Member not found.")] });
    const key = `${message.guild!.id}:${member.id}`;
    const savedRoles = roleSaveStore.get(key);
    if (!savedRoles?.length) return void message.reply({ embeds: [warnEmbed("No saved roles found for this member (only available if they left and rejoined this session).")] });
    let restored = 0;
    for (const roleId of savedRoles) {
      const role = message.guild!.roles.cache.get(roleId);
      if (role && role.id !== message.guild!.id) {
        await member.roles.add(role).catch(() => null);
        restored++;
      }
    }
    roleSaveStore.delete(key);
    await message.reply({ embeds: [successEmbed(`Restored **${restored}** role(s) to ${member}.`)] });
  },
});

// ── edit role ─────────────────────────────────────────────────────────────────
register({
  name: "editrole",
  description: "Rename a role.",
  usage: "<@role> <new name>",
  category: "Moderation",
  aliases: ["roleedit"],
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    const roleId = args[0]?.match(/\d{17,19}/)?.[0];
    if (!roleId || args.length < 2) return void message.reply({ embeds: [errorEmbed("Usage: `-editrole <@role> <new name>`")] });
    const role = message.guild!.roles.cache.get(roleId);
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
    const newName = args.slice(1).join(" ");
    const old = role.name;
    await role.setName(newName);
    await message.reply({ embeds: [successEmbed(`Renamed **${old}** → **${newName}**`)] });
  },
});

// ── filter bypass ─────────────────────────────────────────────────────────────
register({
  name: "filterbypass",
  description: "Allow a user to bypass the word filter in this server.",
  usage: "add <@user> | remove <@user> | list",
  category: "Moderation",
  aliases: ["fbypass"],
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    const sub = args[0]?.toLowerCase();
    const guildId = message.guild!.id;
    if (sub === "list") {
      const bypassed = [...filterBypassUsers].filter((k) => k.startsWith(guildId + ":")).map((k) => `<@${k.split(":")[1]}>`);
      return void message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Filter Bypass List").setDescription(bypassed.join(", ") || "Nobody is bypassing the filter.")] });
    }
    const member = await resolveMember(message, args[1] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const key = `${guildId}:${member.id}`;
    if (sub === "add" || sub === "bypass") {
      filterBypassUsers.add(key);
      return void message.reply({ embeds: [successEmbed(`${member} can now bypass the word filter.`)] });
    }
    if (sub === "remove") {
      filterBypassUsers.delete(key);
      return void message.reply({ embeds: [successEmbed(`${member} can no longer bypass the word filter.`)] });
    }
    await message.reply({ embeds: [errorEmbed("Usage: `-filterbypass add|remove <@user>` or `-filterbypass list`")] });
  },
});

// ── role icon ─────────────────────────────────────────────────────────────────
register({
  name: "roleicon",
  description: "Set an icon (emoji) for a role. (Requires server level 2+)",
  usage: "<emoji> <@role>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed("Usage: `-roleicon <emoji> <@role>`")] });
    const roleId = args[args.length - 1]?.match(/\d{17,19}/)?.[0];
    const icon = args.slice(0, args.length - 1).join(" ");
    if (!roleId || !icon) return void message.reply({ embeds: [errorEmbed("Usage: `-roleicon <emoji> <@role>`")] });
    const role = message.guild!.roles.cache.get(roleId);
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
    try {
      await role.setIcon(icon);
      await message.reply({ embeds: [successEmbed(`Role **${role.name}** icon set to ${icon}`)] });
    } catch {
      await message.reply({ embeds: [errorEmbed("Failed to set role icon. Make sure the server is level 2+ and the emoji is valid.")] });
    }
  },
});

// ── image ban ─────────────────────────────────────────────────────────────────
register({
  name: "imageban",
  description: "Prevent a user from sending images or attachments.",
  usage: "<@user> | unban <@user>",
  category: "Moderation",
  aliases: ["imgban"],
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageMessages))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Messages** permission.")] });
    const sub = args[0]?.toLowerCase();
    const guildId = message.guild!.id;
    if (sub === "unban") {
      const member = await resolveMember(message, args[1] ?? "");
      if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
      imageBannedUsers.delete(`${guildId}:${member.id}`);
      return void message.reply({ embeds: [successEmbed(`${member} can now send images again.`)] });
    }
    const member = await resolveMember(message, args[0] ?? "");
    if (!member) return void message.reply({ embeds: [errorEmbed("Usage: `-imageban <@user>` or `-imageban unban <@user>`")] });
    imageBannedUsers.add(`${guildId}:${member.id}`);
    await message.reply({ embeds: [successEmbed(`${member} is now image banned and cannot send images or attachments.`)] });
  },
});

// ── anti spam ─────────────────────────────────────────────────────────────────
register({
  name: "antispam",
  description: "Toggle anti-spam protection for this server.",
  usage: "on | off",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Server** permission.")] });
    const action = args[0]?.toLowerCase();
    const guildId = message.guild!.id;
    if (action === "on") {
      antiSpamEnabled.add(guildId);
      await message.reply({ embeds: [successEmbed("Anti-spam is now **enabled**. Members sending 5+ messages in 5s will be muted.")] });
    } else if (action === "off") {
      antiSpamEnabled.delete(guildId);
      await message.reply({ embeds: [successEmbed("Anti-spam is now **disabled**.")] });
    } else {
      const status = antiSpamEnabled.has(guildId) ? "enabled" : "disabled";
      await message.reply({ embeds: [infoEmbed(`Anti-spam is currently **${status}**. Use \`-antispam on|off\` to change it.`)] });
    }
  },
});

// ── boosterrole ───────────────────────────────────────────────────────────────
register({
  name: "boosterrole",
  description: "Manage the booster role system.",
  usage: "set <@role> | give <@user> | remove <@user> | list",
  category: "Engagement",
  aliases: ["br"],
  async execute({ message, args }) {
    if (!message.guild) return;
    const sub = args[0]?.toLowerCase();
    const guildId = message.guild.id;

    if (sub === "set") {
      if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
        return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
      const roleId = args[1]?.match(/\d{17,19}/)?.[0];
      if (!roleId) return void message.reply({ embeds: [errorEmbed("Usage: `-boosterrole set <@role>`")] });
      const role = message.guild.roles.cache.get(roleId);
      if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
      boosterRoleBase.set(guildId, roleId);
      await db.insert(guildBoosterRoleConfigTable)
        .values({ guildId, baseRoleId: roleId })
        .onConflictDoUpdate({ target: guildBoosterRoleConfigTable.guildId, set: { baseRoleId: roleId, updatedAt: new Date() } });
      await message.reply({ embeds: [successEmbed(`Booster role base set to **${role.name}**. Boosters can now create personal roles.`)] });
    } else if (sub === "give") {
      if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
        return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
      const member = await resolveMember(message, args[1] ?? "");
      if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
      const existing = await db.select().from(boosterRolesTable)
        .where(and(eq(boosterRolesTable.guildId, guildId), eq(boosterRolesTable.userId, member.id))).limit(1);
      if (!existing.length) return void message.reply({ embeds: [warnEmbed(`${member} does not have a personal booster role.`)] });
      const role = message.guild.roles.cache.get(existing[0].roleId);
      if (role) {
        await member.roles.add(role).catch(() => null);
        await message.reply({ embeds: [successEmbed(`Gave **${role.name}** to ${member}.`)] });
      }
    } else if (sub === "remove") {
      if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
        return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
      const member = await resolveMember(message, args[1] ?? "");
      if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
      const existing = await db.select().from(boosterRolesTable)
        .where(and(eq(boosterRolesTable.guildId, guildId), eq(boosterRolesTable.userId, member.id))).limit(1);
      if (!existing.length) return void message.reply({ embeds: [warnEmbed(`${member} does not have a personal booster role.`)] });
      const role = message.guild.roles.cache.get(existing[0].roleId);
      if (role) {
        await member.roles.remove(role).catch(() => null);
        await message.reply({ embeds: [successEmbed(`Removed **${role.name}** from ${member}.`)] });
      }
    } else if (sub === "list") {
      const rows = await db.select().from(boosterRolesTable).where(eq(boosterRolesTable.guildId, guildId));
      if (!rows.length) return void message.reply({ embeds: [infoEmbed("No booster roles found.")] });
      const lines = rows.map((r) => {
        const role = message.guild!.roles.cache.get(r.roleId);
        return `<@${r.userId}> → ${role ? role.toString() : `<@&${r.roleId}>`}`;
      });
      await message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Booster Roles").setDescription(lines.join("\n"))] });
    } else if (sub === "create") {
      // Personal booster role: -br create <name> #hex
      const isBooster = message.member?.premiumSince != null;
      if (!isBooster && !requirePerms(message, PermissionFlagsBits.ManageRoles))
        return void message.reply({ embeds: [errorEmbed("Only server boosters can create a personal role.")] });
      const name = args[1];
      const hex = args[2]?.replace("#", "");
      if (!name) return void message.reply({ embeds: [errorEmbed("Usage: `-br create <name> [#hex_color]`")] });
      const color = hex ? parseInt(hex, 16) : 0x5865f2;
      const config = await db.select().from(guildBoosterRoleConfigTable)
        .where(eq(guildBoosterRoleConfigTable.guildId, guildId)).limit(1);
      const baseRoleId = config[0]?.baseRoleId ?? undefined;
      const baseRole = baseRoleId ? message.guild!.roles.cache.get(baseRoleId) : undefined;
      try {
        const role = await message.guild!.roles.create({ name, color, position: baseRole ? baseRole.position + 1 : 1 });
        await message.member!.roles.add(role);
        await db.insert(boosterRolesTable).values({ guildId, userId: message.author.id, roleId: role.id });
        await message.reply({ embeds: [successEmbed(`Created personal role **${role.name}** (${role}) for you!`)] });
      } catch {
        await message.reply({ embeds: [errorEmbed("Failed to create role. Check bot permissions.")] });
      }
    } else if (sub === "color") {
      const hex = args[1]?.replace("#", "");
      if (!hex) return void message.reply({ embeds: [errorEmbed("Usage: `-br color <#hex>`")] });
      const existing = await db.select().from(boosterRolesTable)
        .where(and(eq(boosterRolesTable.guildId, guildId), eq(boosterRolesTable.userId, message.author.id))).limit(1);
      if (!existing.length) return void message.reply({ embeds: [warnEmbed("You don't have a personal booster role. Use `-br create <name>` first.")] });
      const role = message.guild!.roles.cache.get(existing[0].roleId);
      if (!role) return void message.reply({ embeds: [errorEmbed("Your role no longer exists.")] });
      await role.setColor(parseInt(hex, 16) as any);
      await message.reply({ embeds: [successEmbed(`Your role color updated to **#${hex}**.`)] });
    } else if (sub === "name") {
      const newName = args.slice(1).join(" ");
      if (!newName) return void message.reply({ embeds: [errorEmbed("Usage: `-br name <new name>`")] });
      const existing = await db.select().from(boosterRolesTable)
        .where(and(eq(boosterRolesTable.guildId, guildId), eq(boosterRolesTable.userId, message.author.id))).limit(1);
      if (!existing.length) return void message.reply({ embeds: [warnEmbed("You don't have a personal booster role.")] });
      const role = message.guild!.roles.cache.get(existing[0].roleId);
      if (!role) return void message.reply({ embeds: [errorEmbed("Your role no longer exists.")] });
      await role.setName(newName);
      await message.reply({ embeds: [successEmbed(`Your role renamed to **${newName}**.`)] });
    } else if (sub === "info") {
      const existing = await db.select().from(boosterRolesTable)
        .where(and(eq(boosterRolesTable.guildId, guildId), eq(boosterRolesTable.userId, message.author.id))).limit(1);
      if (!existing.length) return void message.reply({ embeds: [warnEmbed("You don't have a personal booster role.")] });
      const role = message.guild!.roles.cache.get(existing[0].roleId);
      if (!role) return void message.reply({ embeds: [errorEmbed("Your role no longer exists.")] });
      await message.reply({ embeds: [new EmbedBuilder().setColor(role.color).setTitle("Your Booster Role").addFields({ name: "Name", value: role.name, inline: true }, { name: "Color", value: `#${role.color.toString(16).padStart(6, "0")}`, inline: true }, { name: "Members", value: String(role.members.size), inline: true })] });
    } else if (sub === "delete") {
      const existing = await db.select().from(boosterRolesTable)
        .where(and(eq(boosterRolesTable.guildId, guildId), eq(boosterRolesTable.userId, message.author.id))).limit(1);
      if (!existing.length) return void message.reply({ embeds: [warnEmbed("You don't have a personal booster role.")] });
      const role = message.guild!.roles.cache.get(existing[0].roleId);
      await role?.delete().catch(() => null);
      await db.delete(boosterRolesTable).where(and(eq(boosterRolesTable.guildId, guildId), eq(boosterRolesTable.userId, message.author.id)));
      await message.reply({ embeds: [successEmbed("Your personal booster role has been deleted.")] });
    } else {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Booster Roles Help")
          .addFields(
            { name: "Admin Commands", value: "`-boosterrole set @role`\n`-boosterrole give @user`\n`-boosterrole remove @user`\n`-boosterrole list`" },
            { name: "Personal Commands (Boosters)", value: "`-br create <name> [#hex]`\n`-br color #hex`\n`-br name <new name>`\n`-br info`\n`-br delete`" }
          )],
      });
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// ═══════════════════════ SERVER BACKUP COMMANDS ═══════════════════════════════
// ──────────────────────────────────────────────────────────────────────────────

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

async function captureServerSnapshot(guild: import("discord.js").Guild): Promise<ServerSnapshot> {
  await guild.channels.fetch();
  const categories: SavedCategory[] = [];
  const channels: SavedChannel[] = [];

  for (const [, ch] of guild.channels.cache) {
    // Skip threads — they have no independent permission overwrites
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
        // Only save channels that have permissionOverwrites (all non-thread GuildChannels do)
        if (!c.permissionOverwrites) continue;
        const parentName = c.parent?.name ?? null;
        channels.push({
          id: c.id,
          name: c.name,
          type: c.type,
          position: c.rawPosition,
          parentName,
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
      logger.warn({ err, channelId: ch.id, channelName: (ch as any).name }, "Skipped channel during snapshot capture");
    }
  }

  categories.sort((a, b) => a.position - b.position);
  channels.sort((a, b) => a.position - b.position);
  return { categories, channels };
}

async function applySnapshot(
  guild: import("discord.js").Guild,
  snapshot: ServerSnapshot,
  applyPermissions: boolean,
): Promise<{ created: number; skipped: number }> {
  await guild.channels.fetch();
  let created = 0; let skipped = 0;

  // Map saved category name → newly created (or existing) category id
  const categoryMap = new Map<string, string>();

  // Ensure categories exist
  for (const cat of snapshot.categories) {
    const existing = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === cat.name.toLowerCase()
    );
    if (existing) {
      categoryMap.set(cat.name, existing.id);
      skipped++;
      continue;
    }
    const overwrites = applyPermissions ? cat.permissionOverwrites.map(pw => ({
      id: pw.id, type: pw.type as 0 | 1,
      allow: BigInt(pw.allow), deny: BigInt(pw.deny),
    })) : [];
    try {
      const newCat = await guild.channels.create({
        name: cat.name, type: ChannelType.GuildCategory,
        position: cat.position,
        permissionOverwrites: overwrites,
      });
      categoryMap.set(cat.name, newCat.id);
      created++;
    } catch { skipped++; }
  }

  // Ensure channels exist
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
          topic: ch.topic ?? undefined, nsfw: ch.nsfw,
          permissionOverwrites: overwrites,
        });
        created++;
      } else if (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) {
        await guild.channels.create({
          name: ch.name, type: ch.type as ChannelType.GuildVoice | ChannelType.GuildStageVoice,
          parent: parentId, position: ch.position,
          bitrate: ch.bitrate, userLimit: ch.userLimit,
          permissionOverwrites: overwrites,
        });
        created++;
      } else {
        await guild.channels.create({
          name: ch.name, type: ChannelType.GuildText,
          parent: parentId, position: ch.position,
          permissionOverwrites: overwrites,
        });
        created++;
      }
    } catch { skipped++; }
  }

  return { created, skipped };
}

// ── save server ───────────────────────────────────────────────────────────────

register({
  name: "save",
  description: "Saves the current server structure (channels, categories, permissions) for later restoration. Server owner only.",
  usage: "server",
  category: "Security",
  async execute({ message, args }) {
    if (message.guild!.ownerId !== message.author.id)
      return void message.reply({ embeds: [errorEmbed("🔒 Only the **server owner** can use this command.")] });
    if (args[0]?.toLowerCase() !== "server")
      return void message.reply({ embeds: [errorEmbed("Usage: `-save server`")] });

    const guild = message.guild!;
    const saving = await message.reply({ embeds: [infoEmbed("Saving server...").setDescription("Capturing all channels, categories and permissions...")] });
    try {
      const snapshot = await captureServerSnapshot(guild);
      const data = JSON.stringify(snapshot);
      await db.delete(serverSnapshotTable)
        .where(and(eq(serverSnapshotTable.guildId, guild.id), eq(serverSnapshotTable.slot, 0)));
      await db.insert(serverSnapshotTable).values({ guildId: guild.id, slot: 0, data });
      await saving.edit({ embeds: [successEmbed(`Server saved! Captured **${snapshot.categories.length}** categories and **${snapshot.channels.length}** channels. Use \`-restore server\` to restore.`)] });
    } catch (err) {
      logger.error({ err }, "Failed to save server snapshot");
      await saving.edit({ embeds: [errorEmbed(`Failed to save server. Error: ${(err as Error).message}`)] });
    }
  },
});

// ── restore server ────────────────────────────────────────────────────────────

register({
  name: "restore",
  description: "Restores the server to its last saved state, bans the nuker, and removes their messages. Server owner only.",
  usage: "server",
  category: "Security",
  async execute({ message, args }) {
    if (message.guild!.ownerId !== message.author.id)
      return void message.reply({ embeds: [errorEmbed("🔒 Only the **server owner** can use this command.")] });
    if (args[0]?.toLowerCase() !== "server")
      return void message.reply({ embeds: [errorEmbed("Usage: `-restore server`")] });

    const guild = message.guild!;
    const [row] = await db.select().from(serverSnapshotTable)
      .where(and(eq(serverSnapshotTable.guildId, guild.id), eq(serverSnapshotTable.slot, 0)))
      .limit(1);
    if (!row) return void message.reply({ embeds: [errorEmbed("No server save found. Use `-save server` first.")] });

    const restoring = await message.reply({ embeds: [infoEmbed("Restoring server...").setDescription("Detecting nuker, banning, and rebuilding channels...")] });

    // Detect nuker via recent channel delete audit logs
    const nukerIds = new Set<string>();
    try {
      const auditLogs = await guild.fetchAuditLogs({ limit: 50, type: AuditLogEvent.ChannelDelete });
      const cutoff = Date.now() - 10 * 60 * 1000; // last 10 minutes
      const counts = new Map<string, number>();
      for (const entry of auditLogs.entries.values()) {
        if (entry.createdTimestamp < cutoff) continue;
        if (!entry.executorId || entry.executorId === message.client.user?.id) continue;
        counts.set(entry.executorId, (counts.get(entry.executorId) ?? 0) + 1);
      }
      for (const [id, count] of counts) {
        if (count >= 2) nukerIds.add(id);
      }
      // Also check role deletes
      const roleLogs = await guild.fetchAuditLogs({ limit: 50, type: AuditLogEvent.RoleDelete });
      for (const entry of roleLogs.entries.values()) {
        if (entry.createdTimestamp < cutoff) continue;
        if (!entry.executorId || entry.executorId === message.client.user?.id) continue;
        counts.set(entry.executorId, (counts.get(entry.executorId) ?? 0) + 1);
      }
      for (const [id, count] of counts) {
        if (count >= 2) nukerIds.add(id);
      }
    } catch {}

    // Ban nukers and delete their messages
    const bannedNames: string[] = [];
    for (const nukerId of nukerIds) {
      try {
        const nukerUser = await message.client.users.fetch(nukerId).catch(() => null);
        const nukerMember = await guild.members.fetch(nukerId).catch(() => null);
        // Delete messages sent by the nuker in all text channels
        for (const [, ch] of guild.channels.cache) {
          if (!ch.isTextBased() || ch.type === ChannelType.GuildCategory) continue;
          try {
            const textCh = ch as import("discord.js").TextChannel;
            const msgs = await textCh.messages.fetch({ limit: 100 });
            const toDelete = msgs.filter(m => m.author.id === nukerId);
            if (toDelete.size > 0) await textCh.bulkDelete(toDelete).catch(() => null);
          } catch {}
        }
        if (nukerMember) {
          await nukerMember.ban({ reason: "AntiNuke: server nuke detected - auto banned during restore" }).catch(() => null);
        } else {
          await guild.bans.create(nukerId, { reason: "AntiNuke: server nuke detected - auto banned during restore" }).catch(() => null);
        }
        bannedNames.push(nukerUser?.tag ?? nukerId);
      } catch {}
    }

    // Restore missing channels
    let created = 0; let skipped = 0;
    try {
      const snapshot: ServerSnapshot = JSON.parse(row.data);
      const result = await applySnapshot(guild, snapshot, true);
      created = result.created; skipped = result.skipped;
    } catch (err) {
      logger.error({ err }, "Failed to apply server snapshot");
      await restoring.edit({ embeds: [errorEmbed("Failed to restore server channels.")] });
      return;
    }

    const banText = bannedNames.length > 0 ? `\n🔨 **Banned:** ${bannedNames.join(", ")}` : "\n⚠️ No nuker detected in recent audit logs.";
    await restoring.edit({
      embeds: [successEmbed(`Server restored!`)
        .setDescription(`✅ Created **${created}** missing channels/categories.\n⏭️ Skipped **${skipped}** existing ones.${banText}`)],
    });
  },
});

// ── server create / dump ──────────────────────────────────────────────────────

register({
  name: "server",
  description: "Save or load a server template by number. Server owner only.",
  usage: "create {number} | dump {number}",
  category: "Security",
  async execute({ message, args }) {
    if (message.guild!.ownerId !== message.author.id)
      return void message.reply({ embeds: [errorEmbed("🔒 Only the **server owner** can use this command.")] });

    const subCmd = args[0]?.toLowerCase();
    const slotArg = parseInt(args[1] ?? "", 10);

    if (subCmd !== "create" && subCmd !== "dump")
      return void message.reply({ embeds: [errorEmbed("Usage: `-server create {number}` or `-server dump {number}`")] });
    if (isNaN(slotArg) || slotArg < 1 || slotArg > 999)
      return void message.reply({ embeds: [errorEmbed("Slot must be a number between 1 and 999.")] });

    const guild = message.guild!;

    if (subCmd === "create") {
      const saving = await message.reply({ embeds: [infoEmbed(`Saving server to slot **${slotArg}**...`).setDescription("Capturing all channels, categories and permissions...")] });
      try {
        const snapshot = await captureServerSnapshot(guild);
        const data = JSON.stringify(snapshot);
        await db.delete(serverSnapshotTable)
          .where(and(eq(serverSnapshotTable.guildId, guild.id), eq(serverSnapshotTable.slot, slotArg)));
        await db.insert(serverSnapshotTable).values({ guildId: guild.id, slot: slotArg, data });
        await saving.edit({ embeds: [successEmbed(`Server saved to slot **${slotArg}**! Captured **${snapshot.categories.length}** categories and **${snapshot.channels.length}** channels.`)] });
      } catch (err) {
        logger.error({ err }, "Failed to save server snapshot");
        await saving.edit({ embeds: [errorEmbed(`Failed to save server. Error: ${(err as Error).message}`)] });
      }
    } else {
      // dump
      const [row] = await db.select().from(serverSnapshotTable)
        .where(and(eq(serverSnapshotTable.guildId, guild.id), eq(serverSnapshotTable.slot, slotArg)))
        .limit(1);

      // Also check if this slot was saved from another guild (if the user dumped it here by ID – not supported in this flow)
      // For now: only dump slots saved in the same guild
      if (!row) return void message.reply({ embeds: [errorEmbed(`No server template found at slot **${slotArg}**. Use \`-server create ${slotArg}\` first.`)] });

      const dumping = await message.reply({ embeds: [infoEmbed(`Dumping slot **${slotArg}** into this server...`).setDescription("Creating channels and categories...")] });
      try {
        const snapshot: ServerSnapshot = JSON.parse(row.data);
        const { created, skipped } = await applySnapshot(guild, snapshot, false);
        await dumping.edit({
          embeds: [successEmbed(`Dump complete!`)
            .setDescription(`✅ Created **${created}** channels/categories.\n⏭️ Skipped **${skipped}** that already exist.`)],
        });
      } catch (err) {
        logger.error({ err }, "Failed to dump server snapshot");
        await dumping.edit({ embeds: [errorEmbed("Failed to dump server template.")] });
      }
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// Handler Registration
// ──────────────────────────────────────────────────────────────────────────────

let handlerRegistered = false;

export function registerPrefixHandler(client: Client): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  // ── Command dispatcher ────────────────────────────────────────────────────
  const seenIds = new Set<string>();

  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;
    if (seenIds.has(message.id)) return;
    seenIds.add(message.id);
    setTimeout(() => seenIds.delete(message.id), 10_000);
    const guildId = message.guild.id;
    const userKey = `${guildId}:${message.author.id}`;

    // ── Image ban check ───────────────────────────────────────────────────
    if (imageBannedUsers.has(userKey) && message.attachments.size > 0) {
      await message.delete().catch(() => null);
      const warn = await message.channel.send({
        content: `<@${message.author.id}>`,
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("🚫 Image Banned").setDescription("You are not allowed to send images or attachments in this server.").setTimestamp()],
      }).catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => null), 6000);
      return;
    }

    // ── Anti-spam check ───────────────────────────────────────────────────
    if (antiSpamEnabled.has(guildId) && !message.author.bot) {
      const now = Date.now();
      const WINDOW = 5000;
      const MAX_MSGS = 5;
      const timestamps = antiSpamTracker.get(userKey) ?? [];
      const recent = timestamps.filter((t) => now - t < WINDOW);
      recent.push(now);
      antiSpamTracker.set(userKey, recent);
      if (recent.length >= MAX_MSGS) {
        antiSpamTracker.delete(userKey);
        const member = message.guild.members.cache.get(message.author.id);
        if (member && member.moderatable) {
          await member.timeout(60_000, "Auto anti-spam").catch(() => null);
          await message.channel.send({
            content: `<@${message.author.id}>`,
            embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("🚫 Anti-Spam").setDescription("You've been timed out for 1 minute due to spamming.").setTimestamp()],
          }).catch(() => null);
        }
      }
    }

    // ── TOS & Custom Word Filter ──────────────────────────────────────────
    if (!filterBypassUsers.has(userKey)) {
      (async () => {
        if (!message.guild) return;
        const content = message.content.toLowerCase();
        const isTos = TOS_WORDS.some((w) => content.includes(w));
        let isCustom = false;
        try {
          let bannedWords = getCached(bannedWordsCache, guildId);
          if (bannedWords === null) {
            const [row] = await db.select({ bannedWords: automodSettingsTable.bannedWords })
              .from(automodSettingsTable).where(eq(automodSettingsTable.guildId, guildId)).limit(1);
            bannedWords = row?.bannedWords ?? [];
            setCached(bannedWordsCache, guildId, bannedWords);
          }
          if (bannedWords.length) isCustom = bannedWords.some((w) => content.includes(w.toLowerCase()));
        } catch {}
        if (isTos || isCustom) {
          await message.delete().catch(() => null);
          const label = isTos ? "Discord TOS" : "the server word filter";
          const warning = await message.channel.send({
            content: `<@${message.author.id}>`,
            embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("⚠️ Message Removed").setDescription(`Your message was deleted because it violates **${label}**.\nPlease keep the conversation appropriate.`).setTimestamp()],
          }).catch(() => null);
          if (warning) setTimeout(() => warning.delete().catch(() => null), 8000);
        }
      })();
    }

    // ── AFK mention detector ──────────────────────────────────────────────
    for (const [, user] of message.mentions.users) {
      const reason = afkStore.get(`${guildId}:${user.id}`);
      if (reason) {
        await message.reply({
          embeds: [warnEmbed(`**${user.tag}** is AFK: ${reason}`)],
        }).catch(() => null);
      }
    }

    // ── Remove AFK when user sends a message ─────────────────────────────
    const afkKey = `${guildId}:${message.author.id}`;

    // ── Resolve per-guild prefix ──────────────────────────────────────────
    let guildPrefix = guildPrefixes.get(guildId);
    if (!guildPrefix) {
      try {
        const [row] = await db.select({ guildPrefix: welcomeSettingsTable.guildPrefix })
          .from(welcomeSettingsTable).where(eq(welcomeSettingsTable.guildId, guildId)).limit(1);
        guildPrefix = row?.guildPrefix ?? PREFIX;
        guildPrefixes.set(guildId, guildPrefix);
      } catch {
        guildPrefix = PREFIX;
      }
    }

    if (afkStore.has(afkKey) && !message.content.startsWith(guildPrefix)) {
      afkStore.delete(afkKey);
      const reply = await message.reply({ embeds: [successEmbed("Welcome back! Your AFK has been removed.")] }).catch(() => null);
      if (reply) setTimeout(() => reply.delete().catch(() => null), 5000);
    }

    if (!message.content.startsWith(guildPrefix)) return;

    const [rawName, ...args] = message.content.slice(guildPrefix.length).trim().split(/\s+/);
    const name = rawName.toLowerCase();
    const cmd = commands.get(name);
    if (!cmd) return;

    try {
      await cmd.execute({ message, args, client });
    } catch (err) {
      logger.error({ err, cmd: name }, "Prefix command error");
      await message.reply({ embeds: [errorEmbed("An unexpected error occurred.")] }).catch(() => null);
    }
  });

  // ── Snipe tracker + Delete Log ────────────────────────────────────────────
  client.on("messageDelete", async (message) => {
    if (message.author?.bot || !message.guild) return;

    // Update snipe store
    if (message.content || message.attachments.size) {
      snipeStore.set(message.channel.id, {
        content: message.content ?? "",
        authorTag: message.author?.tag ?? "Unknown",
        authorAvatar: message.author?.displayAvatarURL() ?? null,
        attachments: [...message.attachments.values()].map((a) => a.url),
        timestamp: Date.now(),
      });
    }

    // Send to log channel
    const logCh = await getEventLogChannel(client, message.guild.id);
    if (!logCh) return;
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🗑️ Message Deleted")
      .addFields(
        { name: "Author", value: `${message.author?.tag ?? "Unknown"} (<@${message.author?.id}>)`, inline: true },
        { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
        { name: "Content", value: message.content ? (message.content.length > 1000 ? message.content.slice(0, 997) + "..." : message.content) : "_No text content_" }
      )
      .setTimestamp();
    if (message.attachments.size) {
      embed.addFields({ name: "Attachments", value: [...message.attachments.values()].map((a) => a.url).join("\n").slice(0, 1024) });
    }
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Message Edit Log ──────────────────────────────────────────────────────
  client.on("messageUpdate", async (oldMsg, newMsg) => {
    if (newMsg.author?.bot || !newMsg.guild) return;
    if (oldMsg.content === newMsg.content) return;

    const logCh = await getEventLogChannel(client, newMsg.guild.id);
    if (!logCh) return;
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("✏️ Message Edited")
      .addFields(
        { name: "Author", value: `${newMsg.author?.tag ?? "Unknown"} (<@${newMsg.author?.id}>)`, inline: true },
        { name: "Channel", value: `<#${newMsg.channel.id}>`, inline: true },
        { name: "Before", value: (oldMsg.content ?? "_empty_").slice(0, 1024) },
        { name: "After", value: (newMsg.content ?? "_empty_").slice(0, 1024) },
      )
      .setURL(newMsg.url)
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Voice State Log ───────────────────────────────────────────────────────
  client.on("voiceStateUpdate", async (oldState, newState) => {
    if (newState.member?.user.bot) return;
    const guild = newState.guild ?? oldState.guild;
    const logCh = await getVcLogChannel(client, guild.id);
    if (!logCh) return;

    const member = newState.member ?? oldState.member;
    const tag = member?.user.tag ?? "Unknown";
    const mention = `<@${member?.id}>`;

    let title = "";
    let color = 0x5865f2;
    let channelInfo = "";

    if (!oldState.channelId && newState.channelId) {
      title = "🔊 Joined Voice Channel";
      color = 0x57f287;
      channelInfo = `<#${newState.channelId}>`;
    } else if (oldState.channelId && !newState.channelId) {
      title = "🔇 Left Voice Channel";
      color = 0xed4245;
      channelInfo = `<#${oldState.channelId}>`;
    } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      title = "🔀 Switched Voice Channel";
      color = 0xfee75c;
      channelInfo = `<#${oldState.channelId}> → <#${newState.channelId}>`;
    } else if (!oldState.selfMute && newState.selfMute) {
      title = "🔇 Member Self-Muted";
      channelInfo = `<#${newState.channelId}>`;
    } else if (oldState.selfMute && !newState.selfMute) {
      title = "🔊 Member Self-Unmuted";
      channelInfo = `<#${newState.channelId}>`;
    } else if (!oldState.serverMute && newState.serverMute) {
      title = "🔇 Member Server-Muted";
      color = 0xfee75c;
      channelInfo = `<#${newState.channelId}>`;
    } else if (oldState.serverMute && !newState.serverMute) {
      title = "🔊 Member Server-Unmuted";
      color = 0x57f287;
      channelInfo = `<#${newState.channelId}>`;
    } else {
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .addFields(
        { name: "Member", value: `${tag} (${mention})`, inline: true },
        { name: "Channel", value: channelInfo || "Unknown", inline: true }
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Ban Log ───────────────────────────────────────────────────────────────
  client.on("guildBanAdd", async (ban) => {
    // ── AntiNuke: 3 bans in 5 seconds → auto-ban executor ─────────────────
    try {
      const [nukeSettings] = await db.select()
        .from(antinukeSettingsTable)
        .where(eq(antinukeSettingsTable.guildId, ban.guild.id))
        .limit(1);
      if (nukeSettings?.enabled) {
        const auditLogs = await ban.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberBanAdd });
        const entry = auditLogs.entries.first();
        const executorId = entry?.executorId;
        if (executorId && executorId !== client.user?.id) {
          const whitelisted = await db.select()
            .from(antinukeWhitelistTable)
            .where(and(eq(antinukeWhitelistTable.guildId, ban.guild.id), eq(antinukeWhitelistTable.targetId, executorId)))
            .limit(1);
          if (!whitelisted.length) {
            if (!antinukeBanTracker.has(ban.guild.id)) antinukeBanTracker.set(ban.guild.id, new Map());
            const guildMap = antinukeBanTracker.get(ban.guild.id)!;
            const prev = guildMap.get(executorId) ?? [];
            const now = Date.now();
            const recent = prev.filter((t) => now - t < 5000);
            recent.push(now);
            guildMap.set(executorId, recent);
            if (recent.length >= 3) {
              guildMap.delete(executorId);
              const executor = await ban.guild.members.fetch(executorId).catch(() => null);
              if (executor) {
                await executor.ban({ reason: "AntiNuke: mass ban detected (3+ bans in 5s)" }).catch(() => null);
              }
              const logCh2 = await getEventLogChannel(client, ban.guild.id);
              if (logCh2) {
                await logCh2.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("🛡️ AntiNuke Triggered").setDescription(`<@${executorId}> was banned for mass banning 3+ members within 5 seconds.`).setTimestamp()] }).catch(() => null);
              }
            }
          }
        }
      }
    } catch {}

    const logCh = await getEventLogChannel(client, ban.guild.id);
    if (!logCh) return;

    let moderator = "Unknown";
    let reason = ban.reason ?? "No reason provided";
    try {
      const auditLogs = await ban.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberBanAdd });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === ban.user.id) {
        moderator = entry.executor?.tag ?? "Unknown";
        reason = entry.reason ?? reason;
      }
    } catch {}

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🔨 Member Banned")
      .setThumbnail(ban.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${ban.user.tag} (<@${ban.user.id}>)`, inline: true },
        { name: "Moderator", value: moderator, inline: true },
        { name: "Reason", value: reason }
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Unban Log ─────────────────────────────────────────────────────────────
  client.on("guildBanRemove", async (ban) => {
    const logCh = await getEventLogChannel(client, ban.guild.id);
    if (!logCh) return;

    let moderator = "Unknown";
    try {
      const auditLogs = await ban.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberBanRemove });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === ban.user.id) moderator = entry.executor?.tag ?? "Unknown";
    } catch {}

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✅ Member Unbanned")
      .addFields(
        { name: "User", value: `${ban.user.tag} (<@${ban.user.id}>)`, inline: true },
        { name: "Moderator", value: moderator, inline: true }
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Kick / Leave Log ──────────────────────────────────────────────────────
  client.on("guildMemberRemove", async (member) => {
    // Save roles before member leaves (for -rolerestore)
    const roleIds = (member as GuildMember).roles?.cache
      .filter((r) => r.id !== member.guild.id)
      .map((r) => r.id) ?? [];
    if (roleIds.length) roleSaveStore.set(`${member.guild.id}:${member.id}`, roleIds);

    const logCh = await getEventLogChannel(client, member.guild.id);
    if (!logCh) return;

    let isKick = false;
    let moderator = "Unknown";
    let reason = "No reason provided";
    try {
      const auditLogs = await member.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberKick });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === member.id && Date.now() - entry.createdTimestamp < 5000) {
        isKick = true;
        moderator = entry.executor?.tag ?? "Unknown";
        reason = entry.reason ?? reason;
      }
    } catch {}

    const embed = new EmbedBuilder()
      .setColor(isKick ? 0xfee75c : 0x99aab5)
      .setTitle(isKick ? "👢 Member Kicked" : "👋 Member Left")
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${member.user?.tag ?? "Unknown"} (<@${member.id}>)`, inline: true },
        ...(isKick ? [
          { name: "Moderator", value: moderator, inline: true },
          { name: "Reason", value: reason }
        ] : [])
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Member Join Log + Autorole + PingOnJoin + Welcome ─────────────────────
  client.on("guildMemberAdd", async (member) => {
    // Fetch guild settings
    let settings: Awaited<ReturnType<typeof db.select>> extends (infer R)[] ? R : never = {} as any;
    try {
      const [row] = await db.select()
        .from(welcomeSettingsTable)
        .where(eq(welcomeSettingsTable.guildId, member.guild.id))
        .limit(1);
      if (row) settings = row as any;
    } catch {}

    // Autorole
    const autoRoleId = (settings as any)?.autoRoleId;
    if (autoRoleId) {
      try {
        const role = member.guild.roles.cache.get(autoRoleId)
          ?? await member.guild.roles.fetch(autoRoleId).catch(() => null);
        if (role) await member.roles.add(role, "Autorole").catch(() => null);
      } catch {}
    }

    // Ping on join channel (separate from welcome channel)
    const pingOnJoinChannelId = (settings as any)?.pingOnJoinChannelId;
    if (pingOnJoinChannelId) {
      try {
        const ch = await client.channels.fetch(pingOnJoinChannelId);
        if (ch?.isTextBased() && "send" in ch) {
          await (ch as any).send({ content: `<@${member.id}>`, embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`Welcome to ${member.guild.name}!`).setDescription(`Hey <@${member.id}>, welcome to **${member.guild.name}**! Enjoy your stay 🎉`).setThumbnail(member.user.displayAvatarURL()).setFooter({ text: `Member #${member.guild.memberCount}` }).setTimestamp()] });
        }
      } catch {}
    }

    // Welcome channel (ping user)
    const welcomeEnabled = (settings as any)?.welcomeEnabled;
    const welcomeChannelId = (settings as any)?.welcomeChannelId;
    if (welcomeEnabled && welcomeChannelId) {
      try {
        const ch = await client.channels.fetch(welcomeChannelId);
        if (ch?.isTextBased() && "send" in ch) {
          const msg = ((settings as any)?.welcomeMessage ?? "Welcome to the server, {user}!")
            .replace("{user}", `<@${member.id}>`)
            .replace("{username}", member.user.username)
            .replace("{server}", member.guild.name)
            .replace("{memberCount}", String(member.guild.memberCount));
          await (ch as any).send({ content: `<@${member.id}>`, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Welcome to ${member.guild.name}!`).setDescription(msg).setThumbnail(member.user.displayAvatarURL()).setFooter({ text: `Member #${member.guild.memberCount}` }).setTimestamp()] });
        }
      } catch {}
    }

    // Event log
    const logCh = await getEventLogChannel(client, member.guild.id);
    if (!logCh) return;
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("📥 Member Joined")
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${member.user.tag} (<@${member.id}>)`, inline: true },
        { name: "Account Age", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: "Member #", value: member.guild.memberCount.toLocaleString(), inline: true }
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Vanity Role: presenceUpdate ────────────────────────────────────────────
  client.on("presenceUpdate", async (_oldPresence, newPresence) => {
    if (!newPresence.guild || !newPresence.member) return;
    try {
      const [settings] = await db.select({ vanityCode: welcomeSettingsTable.vanityCode, vanityRoleId: welcomeSettingsTable.vanityRoleId })
        .from(welcomeSettingsTable)
        .where(eq(welcomeSettingsTable.guildId, newPresence.guild.id))
        .limit(1);
      if (!settings?.vanityCode || !settings?.vanityRoleId) return;
      const member = newPresence.member as GuildMember;
      const role = newPresence.guild.roles.cache.get(settings.vanityRoleId);
      if (!role) return;
      const hasVanity = newPresence.activities?.some((a) => {
        const stateOrUrl = (a.state ?? "") + (a.url ?? "");
        return stateOrUrl.toLowerCase().includes(settings.vanityCode!.toLowerCase());
      }) ?? false;
      if (hasVanity && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, "Vanity URL in status").catch(() => null);
      } else if (!hasVanity && member.roles.cache.has(role.id)) {
        await member.roles.remove(role, "Vanity URL removed from status").catch(() => null);
      }
    } catch {}
  });

  // ── Timeout / Mute / Role Change Log ─────────────────────────────────────
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    const logCh = await getEventLogChannel(client, newMember.guild.id);
    if (!logCh) return;

    const oldTimeout = (oldMember as GuildMember).communicationDisabledUntilTimestamp;
    const newTimeout = (newMember as GuildMember).communicationDisabledUntilTimestamp;
    const now = Date.now();

    // Timeout applied
    if ((!oldTimeout || oldTimeout < now) && newTimeout && newTimeout > now) {
      let moderator = "Unknown";
      let reason = "No reason provided";
      try {
        const auditLogs = await newMember.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberUpdate });
        const entry = auditLogs.entries.first();
        if (entry && entry.targetId === newMember.id) {
          moderator = entry.executor?.tag ?? "Unknown";
          reason = entry.reason ?? reason;
        }
      } catch {}
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle("⏱️ Member Timed Out")
        .addFields(
          { name: "Member", value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: true },
          { name: "Moderator", value: moderator, inline: true },
          { name: "Expires", value: `<t:${Math.floor(newTimeout / 1000)}:R>`, inline: true },
          { name: "Reason", value: reason }
        )
        .setTimestamp();
      await logCh.send({ embeds: [embed] }).catch(() => null);
      return;
    }

    // Timeout removed
    if (oldTimeout && oldTimeout > now && (!newTimeout || newTimeout <= now)) {
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ Timeout Removed")
        .addFields({ name: "Member", value: `${newMember.user.tag} (<@${newMember.id}>)` })
        .setTimestamp();
      await logCh.send({ embeds: [embed] }).catch(() => null);
      return;
    }

    // Role changes
    const oldRoles = (oldMember as GuildMember).roles.cache;
    const newRoles = (newMember as GuildMember).roles.cache;
    const added = newRoles.filter((r) => !oldRoles.has(r.id));
    const removed = oldRoles.filter((r) => !newRoles.has(r.id));

    if (added.size || removed.size) {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🎭 Member Roles Updated")
        .addFields(
          { name: "Member", value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: true },
          ...(added.size ? [{ name: "Roles Added", value: added.map((r) => `<@&${r.id}>`).join(", ").slice(0, 1024) }] : []),
          ...(removed.size ? [{ name: "Roles Removed", value: removed.map((r) => `<@&${r.id}>`).join(", ").slice(0, 1024) }] : [])
        )
        .setTimestamp();
      await logCh.send({ embeds: [embed] }).catch(() => null);
      return;
    }

    // Nickname change
    const oldNick = (oldMember as GuildMember).nickname;
    const newNick = (newMember as GuildMember).nickname;
    if (oldNick !== newNick) {
      let moderator = "Unknown";
      try {
        const auditLogs = await newMember.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberUpdate });
        const entry = auditLogs.entries.first();
        if (entry && entry.targetId === newMember.id) moderator = entry.executor?.tag ?? "Unknown";
      } catch {}
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("✏️ Nickname Changed")
        .addFields(
          { name: "Member", value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: true },
          { name: "Changed By", value: moderator, inline: true },
          { name: "Before", value: oldNick ?? "_None_", inline: true },
          { name: "After", value: newNick ?? "_None_", inline: true }
        )
        .setTimestamp();
      await logCh.send({ embeds: [embed] }).catch(() => null);
    }
  });

  // ── Invite Create Log ─────────────────────────────────────────────────────
  client.on("inviteCreate", async (invite) => {
    if (!invite.guild) return;
    const logCh = await getEventLogChannel(client, invite.guild.id);
    if (!logCh) return;
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("📨 Invite Created")
      .addFields(
        { name: "Code", value: `[${invite.code}](${invite.url})`, inline: true },
        { name: "Created By", value: invite.inviter ? `${invite.inviter.tag} (<@${invite.inviter.id}>)` : "Unknown", inline: true },
        { name: "Channel", value: invite.channel ? `<#${invite.channel.id}>` : "Unknown", inline: true },
        { name: "Max Uses", value: invite.maxUses ? String(invite.maxUses) : "Unlimited", inline: true },
        { name: "Expires", value: invite.maxAge ? `<t:${Math.floor((Date.now() + invite.maxAge * 1000) / 1000)}:R>` : "Never", inline: true },
        { name: "Temporary", value: invite.temporary ? "Yes" : "No", inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Invite Delete Log ─────────────────────────────────────────────────────
  client.on("inviteDelete", async (invite) => {
    if (!invite.guild) return;
    const logCh = await getEventLogChannel(client, invite.guild.id);
    if (!logCh) return;
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🗑️ Invite Deleted")
      .addFields(
        { name: "Code", value: invite.code, inline: true },
        { name: "Channel", value: invite.channel ? `<#${invite.channel.id}>` : "Unknown", inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Channel Create Log ────────────────────────────────────────────────────
  client.on("channelCreate", async (channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    const logCh = await getEventLogChannel(client, channel.guild.id);
    if (!logCh) return;
    let creator = "Unknown";
    try {
      const auditLogs = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelCreate });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === channel.id) creator = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("📁 Channel Created")
      .addFields(
        { name: "Channel", value: `<#${channel.id}> (${channel.name})`, inline: true },
        { name: "Type", value: ChannelType[channel.type], inline: true },
        { name: "Created By", value: creator, inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Channel Delete Log ────────────────────────────────────────────────────
  client.on("channelDelete", async (channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    const logCh = await getEventLogChannel(client, channel.guild.id);
    if (!logCh) return;
    let deletedBy = "Unknown";
    try {
      const auditLogs = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === channel.id) deletedBy = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🗑️ Channel Deleted")
      .addFields(
        { name: "Channel", value: `#${channel.name}`, inline: true },
        { name: "Type", value: ChannelType[channel.type], inline: true },
        { name: "Deleted By", value: deletedBy, inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Channel Update Log ────────────────────────────────────────────────────
  client.on("channelUpdate", async (oldCh, newCh) => {
    if (!("guild" in newCh) || !newCh.guild) return;
    const logCh = await getEventLogChannel(client, newCh.guild.id);
    if (!logCh) return;
    const fields: { name: string; value: string; inline?: boolean }[] = [
      { name: "Channel", value: `<#${newCh.id}> (${newCh.name})`, inline: true },
    ];
    let updatedBy = "Unknown";
    try {
      const auditLogs = await newCh.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelUpdate });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === newCh.id) {
        updatedBy = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
        const changes = (entry.changes ?? []) as { key: string; old?: unknown; new?: unknown }[];
        const desc = describeAuditChanges(changes);
        if (desc) fields.push({ name: "Changes", value: desc });
      }
    } catch {}
    if ("name" in oldCh && "name" in newCh && oldCh.name !== newCh.name)
      fields.push({ name: "Name", value: `${oldCh.name} → ${newCh.name}`, inline: true });
    fields.push({ name: "Updated By", value: updatedBy, inline: true });
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("📝 Channel Updated")
      .addFields(fields)
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Role Create Log ───────────────────────────────────────────────────────
  client.on("roleCreate", async (role) => {
    const logCh = await getEventLogChannel(client, role.guild.id);
    if (!logCh) return;
    let creator = "Unknown";
    try {
      const auditLogs = await role.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.RoleCreate });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === role.id) creator = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✨ Role Created")
      .addFields(
        { name: "Role", value: `<@&${role.id}> (${role.name})`, inline: true },
        { name: "Color", value: role.hexColor, inline: true },
        { name: "Created By", value: creator, inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Role Delete Log ───────────────────────────────────────────────────────
  client.on("roleDelete", async (role) => {
    const logCh = await getEventLogChannel(client, role.guild.id);
    if (!logCh) return;
    let deletedBy = "Unknown";
    try {
      const auditLogs = await role.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.RoleDelete });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === role.id) deletedBy = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🗑️ Role Deleted")
      .addFields(
        { name: "Role", value: role.name, inline: true },
        { name: "Color", value: role.hexColor, inline: true },
        { name: "Deleted By", value: deletedBy, inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Role Update Log ───────────────────────────────────────────────────────
  client.on("roleUpdate", async (oldRole, newRole) => {
    const logCh = await getEventLogChannel(client, newRole.guild.id);
    if (!logCh) return;
    const fields: { name: string; value: string; inline?: boolean }[] = [
      { name: "Role", value: `<@&${newRole.id}> (${newRole.name})`, inline: true },
    ];
    let updatedBy = "Unknown";
    try {
      const auditLogs = await newRole.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.RoleUpdate });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === newRole.id) {
        updatedBy = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
        const changes = (entry.changes ?? []) as { key: string; old?: unknown; new?: unknown }[];
        const desc = describeAuditChanges(changes);
        if (desc) fields.push({ name: "Changes", value: desc });
      }
    } catch {}
    if (oldRole.name !== newRole.name) fields.push({ name: "Name", value: `${oldRole.name} → ${newRole.name}`, inline: true });
    if (oldRole.hexColor !== newRole.hexColor) fields.push({ name: "Color", value: `${oldRole.hexColor} → ${newRole.hexColor}`, inline: true });
    fields.push({ name: "Updated By", value: updatedBy, inline: true });
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎨 Role Updated")
      .addFields(fields)
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Server Update Log ─────────────────────────────────────────────────────
  client.on("guildUpdate", async (oldGuild, newGuild) => {
    const logCh = await getEventLogChannel(client, newGuild.id);
    if (!logCh) return;
    const fields: { name: string; value: string; inline?: boolean }[] = [];
    let updatedBy = "Unknown";
    try {
      const auditLogs = await newGuild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.GuildUpdate });
      const entry = auditLogs.entries.first();
      if (entry) {
        updatedBy = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
        const changes = (entry.changes ?? []) as { key: string; old?: unknown; new?: unknown }[];
        const desc = describeAuditChanges(changes);
        if (desc) fields.push({ name: "Changes", value: desc });
      }
    } catch {}
    if (oldGuild.name !== newGuild.name) fields.push({ name: "Name", value: `${oldGuild.name} → ${newGuild.name}`, inline: true });
    if (oldGuild.verificationLevel !== newGuild.verificationLevel)
      fields.push({ name: "Verification Level", value: `${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`, inline: true });
    if (oldGuild.vanityURLCode !== newGuild.vanityURLCode)
      fields.push({ name: "Vanity URL", value: `${oldGuild.vanityURLCode ?? "None"} → ${newGuild.vanityURLCode ?? "None"}`, inline: true });
    fields.push({ name: "Updated By", value: updatedBy, inline: true });
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("⚙️ Server Updated")
      .setThumbnail(newGuild.iconURL())
      .addFields(fields)
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Bulk Message Delete Log ───────────────────────────────────────────────
  client.on("messageDeleteBulk", async (messages, channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    const logCh = await getEventLogChannel(client, channel.guild.id);
    if (!logCh) return;
    let deletedBy = "Unknown";
    try {
      const auditLogs = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MessageBulkDelete });
      const entry = auditLogs.entries.first();
      if (entry) deletedBy = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🗑️ Bulk Messages Deleted")
      .addFields(
        { name: "Count", value: String(messages.size), inline: true },
        { name: "Channel", value: `<#${channel.id}>`, inline: true },
        { name: "Deleted By", value: deletedBy, inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Thread Create Log ─────────────────────────────────────────────────────
  client.on("threadCreate", async (thread) => {
    if (!thread.guild) return;
    const logCh = await getEventLogChannel(client, thread.guild.id);
    if (!logCh) return;
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("🧵 Thread Created")
      .addFields(
        { name: "Thread", value: `<#${thread.id}> (${thread.name})`, inline: true },
        { name: "Parent", value: thread.parent ? `<#${thread.parent.id}>` : "Unknown", inline: true },
        { name: "Created By", value: thread.ownerId ? `<@${thread.ownerId}>` : "Unknown", inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Emoji & Sticker Log ───────────────────────────────────────────────────
  client.on("emojiCreate", async (emoji) => {
    const logCh = await getEventLogChannel(client, emoji.guild.id);
    if (!logCh) return;
    let creator = "Unknown";
    try {
      const auditLogs = await emoji.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.EmojiCreate });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === emoji.id) creator = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("😄 Emoji Created")
      .addFields(
        { name: "Emoji", value: `${emoji.toString()} \`:${emoji.name}:\``, inline: true },
        { name: "Created By", value: creator, inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  client.on("emojiDelete", async (emoji) => {
    const logCh = await getEventLogChannel(client, emoji.guild.id);
    if (!logCh) return;
    let deletedBy = "Unknown";
    try {
      const auditLogs = await emoji.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.EmojiDelete });
      const entry = auditLogs.entries.first();
      if (entry && entry.targetId === emoji.id) deletedBy = entry.executor ? `${entry.executor.tag} (<@${entry.executor.id}>)` : "Unknown";
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🗑️ Emoji Deleted")
      .addFields(
        { name: "Emoji", value: `:${emoji.name}:`, inline: true },
        { name: "Deleted By", value: deletedBy, inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => null);
  });

  // ── Guild join: DM server owner with save reminder ────────────────────────
  client.on("guildCreate", async (guild) => {
    try {
      const owner = await guild.fetchOwner().catch(() => null);
      if (!owner) return;
      await owner.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("👋 Thanks for adding me to your server!")
            .setDescription(
              `Hey ${owner.user.username}, I'm now in **${guild.name}**.\n\n` +
              `To protect your server, make sure to run:\n\`\`\`-save server\`\`\`\n` +
              `**Do this every time your server changes** (new channels, categories, permissions). ` +
              `If your server ever gets nuked or channels are deleted, just run:\n\`\`\`-restore server\`\`\`\n` +
              `This will restore all missing channels, ban the attacker, and delete their messages automatically.\n\n` +
              `⚠️ Only the **server owner** can run these commands.`
            )
            .setFooter({ text: `Server: ${guild.name}` })
            .setTimestamp(),
        ],
      }).catch(() => null);
    } catch {}
  });
}

// ── Log channel helpers ───────────────────────────────────────────────────────

async function getEventLogChannel(client: Client, guildId: string): Promise<TextChannel | null> {
  try {
    const [row] = await db.select({ eventLogChannelId: welcomeSettingsTable.eventLogChannelId })
      .from(welcomeSettingsTable).where(eq(welcomeSettingsTable.guildId, guildId)).limit(1);
    if (!row?.eventLogChannelId) return null;
    const ch = await client.channels.fetch(row.eventLogChannelId);
    if (ch?.isTextBased() && "send" in ch) return ch as TextChannel;
    return null;
  } catch {
    return null;
  }
}

async function getVcLogChannel(client: Client, guildId: string): Promise<TextChannel | null> {
  try {
    const [row] = await db.select({ vcLogChannelId: welcomeSettingsTable.vcLogChannelId, eventLogChannelId: welcomeSettingsTable.eventLogChannelId })
      .from(welcomeSettingsTable).where(eq(welcomeSettingsTable.guildId, guildId)).limit(1);
    const channelId = row?.vcLogChannelId ?? row?.eventLogChannelId;
    if (!channelId) return null;
    const ch = await client.channels.fetch(channelId);
    if (ch?.isTextBased() && "send" in ch) return ch as TextChannel;
    return null;
  } catch {
    return null;
  }
}

export { commands };
