import {
  Client,
  Message,
  EmbedBuilder,
  PermissionFlagsBits,
  GuildMember,
  ChannelType,
  Collection,
  AuditLogEvent,
  type TextChannel,
  type VoiceChannel,
  type GuildChannel,
  type ButtonBuilder,
} from "discord.js";
import { logger } from "./logger";
import { db } from "@workspace/db";
import { welcomeSettingsTable, automodSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

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
  description: "Shows all commands or details for a specific command.",
  usage: "[command | category]",
  category: "General",
  async execute({ message, args }) {
    const unique = new Map<string, Command>();
    for (const c of commands.values()) if (!unique.has(c.name)) unique.set(c.name, c);

    // ── -help <command> ──
    if (args[0] && !["general", "moderation", "leveling"].includes(args[0].toLowerCase())) {
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

    const cats: Record<string, Command[]> = {};
    for (const c of unique.values()) {
      (cats[c.category] ??= []).push(c);
    }

    const filterCat = args[0]?.toLowerCase();
    const catEmojis: Record<string, string> = { General: "🎮", Moderation: "🛡️", Leveling: "⭐", Giveaway: "🎉", Utility: "🔧" };

    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`📋  /Crossed — Command List`)
      .setDescription(
        `Prefix: \`${PREFIX}\`  •  Use \`${PREFIX}help <command>\` for details\n` +
        `Use \`${PREFIX}help <category>\` to filter  •  \`general\` \`moderation\` \`leveling\``
      )
      .setFooter({ text: `${unique.size} commands total` });

    for (const [cat, cmds] of Object.entries(cats)) {
      if (filterCat && !cat.toLowerCase().startsWith(filterCat)) continue;
      const list = cmds.map((c) => `\`${PREFIX}${c.name}\``).join("  ");
      embed.addFields({ name: `${catEmojis[cat] ?? "•"}  ${cat} (${cmds.length})`, value: list });
    }

    await message.reply({ embeds: [embed] });
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
  usage: "<@role|id>",
  category: "General",
  async execute({ message, args }) {
    const id = args[0]?.match(/\d{17,19}/)?.[0];
    const role = id ? message.guild!.roles.cache.get(id) : null;
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
  usage: "<@role|id>",
  category: "General",
  async execute({ message, args }) {
    const id = args[0]?.match(/\d{17,19}/)?.[0];
    const role = id ? message.guild!.roles.cache.get(id) : null;
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

// ── massban ───────────────────────────────────────────────────────────────────

register({
  name: "massban",
  aliases: ["mban"],
  description: "Bans multiple users by ID at once.",
  usage: "<id1> <id2> ... [reason: <reason>]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.BanMembers))
      return void message.reply({ embeds: [errorEmbed("You need **Ban Members** permission.")] });
    const reasonIdx = args.findIndex((a) => a.toLowerCase().startsWith("reason:"));
    const reason = reasonIdx !== -1 ? args.slice(reasonIdx).join(" ").replace(/^reason:\s*/i, "") : "Mass ban";
    const ids = (reasonIdx !== -1 ? args.slice(0, reasonIdx) : args).filter((a) => /^\d{17,19}$/.test(a));
    if (ids.length === 0) return void message.reply({ embeds: [errorEmbed("Provide at least one valid user ID.")] });
    let success = 0;
    for (const id of ids) {
      try {
        await message.guild!.bans.create(id, { reason: `Massban by ${message.author.tag}: ${reason}` });
        success++;
      } catch {}
    }
    await message.reply({ embeds: [successEmbed(`Banned **${success}/${ids.length}** users.\n**Reason:** ${reason}`)] });
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
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}role <@user> <@role>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const roleId = args[1].match(/\d{17,19}/)?.[0];
    const role = roleId ? message.guild!.roles.cache.get(roleId) : null;
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
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
    const roleId = args[1].match(/\d{17,19}/)?.[0];
    const role = roleId ? message.guild!.roles.cache.get(roleId) : null;
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
    await member.roles.add(role);
    await message.reply({ embeds: [successEmbed(`Added **${role.name}** to ${member}.`)] });
  },
});

// ── removerole ────────────────────────────────────────────────────────────────

register({
  name: "removerole",
  aliases: ["rr", "takerole"],
  description: "Removes a role from a member.",
  usage: "<@user|id> <@role|id>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    if (args.length < 2) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}removerole <@user> <@role>\``)] });
    const member = await resolveMember(message, args[0]);
    if (!member) return void message.reply({ embeds: [errorEmbed("User not found.")] });
    const roleId = args[1].match(/\d{17,19}/)?.[0];
    const role = roleId ? message.guild!.roles.cache.get(roleId) : null;
    if (!role) return void message.reply({ embeds: [errorEmbed("Role not found.")] });
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
    // Remove visible channels access
    const textChannels = message.guild!.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText
    );
    for (const [, ch] of textChannels) {
      await (ch as TextChannel).permissionOverwrites.edit(member, { ViewChannel: false }).catch(() => null);
    }
    await message.reply({ embeds: [warnEmbed(`🔒  **${member.user.tag}** has been jailed.\n**Reason:** ${reason}`)] });
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
    const textChannels = message.guild!.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText
    );
    for (const [, ch] of textChannels) {
      await (ch as TextChannel).permissionOverwrites.delete(member).catch(() => null);
    }
    await message.reply({ embeds: [successEmbed(`**${member.user.tag}** has been released from jail.`)] });
  },
});

// ── setprefix ─────────────────────────────────────────────────────────────────

register({
  name: "setprefix",
  description: "Changes the bot's command prefix (admin only).",
  usage: "<prefix>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a prefix (e.g., `!`, `?`, `.`).")] });
    const newPrefix = args[0];
    if (newPrefix.length > 3) return void message.reply({ embeds: [errorEmbed("Prefix must be 3 characters or less.")] });
    await message.reply({ embeds: [successEmbed(`Prefix changed from \`${PREFIX}\` to \`${newPrefix}\`. **Note:** This requires a bot restart to take effect.`)] });
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

// ── editantinuke ──────────────────────────────────────────────────────────────

register({
  name: "editantinuke",
  aliases: ["setan"],
  description: "Enables/disables anti-nuke features.",
  usage: "enable|disable",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}editantinuke enable|disable\``)] });
    const { autoModConfig } = await import("./automod");
    const action = args[0].toLowerCase();
    if (action === "enable") {
      autoModConfig.enabled = true;
      await message.reply({ embeds: [successEmbed("✅ Anti-nuke system **enabled**.")] });
    } else if (action === "disable") {
      autoModConfig.enabled = false;
      await message.reply({ embeds: [successEmbed("❌ Anti-nuke system **disabled**.")] });
    } else {
      await message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}editantinuke enable|disable\``)] });
    }
  },
});

// ── setwelcome ────────────────────────────────────────────────────────────────

register({
  name: "setwelcome",
  description: "Sets the welcome message channel.",
  usage: "<#channel>",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.Administrator))
      return void message.reply({ embeds: [errorEmbed("You need **Administrator** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed(`Usage: \`${PREFIX}setwelcome <#channel>\``)] });
    const chId = args[0].match(/\d{17,19}/)?.[0];
    const channel = chId ? message.guild!.channels.cache.get(chId) : null;
    if (!channel?.isTextBased()) return void message.reply({ embeds: [errorEmbed("Invalid text channel.")] });
    try {
      await db.insert(welcomeSettingsTable)
        .values({ guildId: message.guild!.id, welcomeChannelId: channel.id, welcomeEnabled: true })
        .onConflictDoUpdate({ target: welcomeSettingsTable.guildId, set: { welcomeChannelId: channel.id, welcomeEnabled: true, updatedAt: new Date() } });
    } catch (err) {
      logger.error({ err }, "Failed to save welcome channel");
    }
    await message.reply({ embeds: [successEmbed(`Welcome channel set to ${channel}.`)] });
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
    await message.reply({ embeds: [successEmbed(`Voice log channel set to ${channel}.`)] });
  },
});

// ── rolecreate ────────────────────────────────────────────────────────────────

register({
  name: "rolecreate",
  aliases: ["cr", "mkrole"],
  description: "Creates a new role.",
  usage: "<name> [color]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ManageRoles))
      return void message.reply({ embeds: [errorEmbed("You need **Manage Roles** permission.")] });
    if (!args[0]) return void message.reply({ embeds: [errorEmbed("Provide a role name.")] });
    const name = args[0];
    const color = args[1]?.replace("#", "") ?? "2f3136";
    try {
      const role = await message.guild!.roles.create({ name, color: parseInt(color, 16) });
      await message.reply({ embeds: [successEmbed(`Role ${role} created successfully.`)] });
    } catch {
      await message.reply({ embeds: [errorEmbed("Could not create role. Invalid color?")] });
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
  aliases: ["clean"],
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

register({
  name: "audit",
  aliases: ["auditlog", "logs"],
  description: "Shows recent audit log entries.",
  usage: "[action-type]",
  category: "Moderation",
  async execute({ message, args }) {
    if (!requirePerms(message, PermissionFlagsBits.ViewAuditLog))
      return void message.reply({ embeds: [errorEmbed("You need **View Audit Log** permission.")] });
    const logs = await message.guild!.fetchAuditLogs({ limit: 10 });
    const entries = logs.entries.first(5);
    const list = entries.map((e) => `**${e.action}** by **${e.executor?.tag}** — ${fmtDuration(Date.now() - e.createdTimestamp)} ago`).join("\n");
    await message.reply({ embeds: [infoEmbed("📋  Audit Log").setDescription(list || "No entries found.")] });
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

// ──────────────────────────────────────────────────────────────────────────────
// Handler Registration
// ──────────────────────────────────────────────────────────────────────────────

let handlerRegistered = false;

export function registerPrefixHandler(client: Client): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  // ── Command dispatcher ────────────────────────────────────────────────────
  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    // ── TOS & Custom Word Filter ──────────────────────────────────────────
    (async () => {
      if (message.author.bot || !message.guild) return;
      const content = message.content.toLowerCase();
      const isTos = TOS_WORDS.some((w) => content.includes(w));
      let isCustom = false;
      try {
        const { db } = await import("@workspace/db");
        const { automodSettingsTable } = await import("@workspace/db/schema");
        const { eq } = await import("drizzle-orm");
        const [row] = await db.select({ bannedWords: automodSettingsTable.bannedWords })
          .from(automodSettingsTable).where(eq(automodSettingsTable.guildId, message.guild.id)).limit(1);
        if (row?.bannedWords?.length) isCustom = row.bannedWords.some((w) => content.includes(w.toLowerCase()));
      } catch {}
      if (isTos || isCustom) {
        await message.delete().catch(() => null);
        const label = isTos ? "Discord TOS" : "the server word filter";
        const warning = await message.channel.send({
          content: `<@${message.author.id}>`,
          embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("⚠️ Message Removed").setDescription(`Your message was deleted because it violates **${label}**.\nPlease keep the conversation appropriate.`).setTimestamp()],
        }).catch(() => null);
        if (warning) setTimeout(() => warning.delete().catch(() => null), 8000);
        return;
      }
    })();

    // ── AFK mention detector ──────────────────────────────────────────────
    for (const [, user] of message.mentions.users) {
      const reason = afkStore.get(`${message.guild.id}:${user.id}`);
      if (reason) {
        await message.reply({
          embeds: [warnEmbed(`**${user.tag}** is AFK: ${reason}`)],
        }).catch(() => null);
      }
    }

    // ── Remove AFK when user sends a message ─────────────────────────────
    const afkKey = `${message.guild.id}:${message.author.id}`;
    if (afkStore.has(afkKey) && !message.content.startsWith(PREFIX)) {
      afkStore.delete(afkKey);
      const reply = await message.reply({ embeds: [successEmbed("Welcome back! Your AFK has been removed.")] }).catch(() => null);
      if (reply) setTimeout(() => reply.delete().catch(() => null), 5000);
    }

    if (!message.content.startsWith(PREFIX)) return;

    const [rawName, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
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

  // ── Snipe tracker ─────────────────────────────────────────────────────────
  client.on("messageDelete", (message) => {
    if (message.author?.bot || !message.guild) return;
    if (!message.content && !message.attachments.size) return;
    snipeStore.set(message.channel.id, {
      content: message.content ?? "",
      authorTag: message.author?.tag ?? "Unknown",
      authorAvatar: message.author?.displayAvatarURL() ?? null,
      attachments: [...message.attachments.values()].map((a) => a.url),
      timestamp: Date.now(),
    });
  });
}

export { commands };
