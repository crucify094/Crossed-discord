import {
  Client,
  EmbedBuilder,
  GuildMember,
  PartialGuildMember,
  Message,
  PartialMessage,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
  TextChannel,
  ChannelType,
  AuditLogEvent,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
} from "discord.js";
import { logger } from "./logger";
import { db } from "@workspace/db";
import { welcomeSettingsTable, reactionRolesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { ticketStore, openTickets, getStatusRoles } from "./prefixCommands";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSettings(guildId: string) {
  const [settings] = await db
    .select()
    .from(welcomeSettingsTable)
    .where(eq(welcomeSettingsTable.guildId, guildId))
    .limit(1);
  return settings ?? null;
}

async function sendToChannel(client: Client, channelId: string, options: Parameters<TextChannel["send"]>[0]) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send(options);
    }
  } catch (err) {
    logger.error({ err }, "Failed to send to channel");
  }
}

function formatMessage(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (str, [key, val]) => str.replace(new RegExp(`\\{${key}\\}`, "g"), val),
    template
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

export function registerEngagementHandlers(client: Client): void {

  // ── Welcome ────────────────────────────────────────────────────────────────
  client.on("guildMemberAdd", async (member: GuildMember) => {
    try {
      const settings = await getSettings(member.guild.id);
      if (!settings) return;

      if (settings.dmWelcome && settings.dmMessage) {
        const dmMsg = formatMessage(settings.dmMessage, {
          user: member.user.username,
          server: member.guild.name,
        });
        await member.send(dmMsg).catch(() => null);
      }
    } catch (err) {
      logger.error({ err }, "Welcome handler failed");
    }
  });

  // ── Goodbye ────────────────────────────────────────────────────────────────
  client.on("guildMemberRemove", async (member: GuildMember | PartialGuildMember) => {
    try {
      const settings = await getSettings(member.guild.id);
      if (!settings?.goodbyeEnabled || !settings.goodbyeChannelId) return;

      const msg = formatMessage(settings.goodbyeMessage, {
        user: member.user?.username ?? "Unknown",
        username: member.user?.username ?? "Unknown",
        server: member.guild.name,
      });

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setDescription(msg)
        .setThumbnail(member.user?.displayAvatarURL() ?? null)
        .setTimestamp();

      await sendToChannel(client, settings.goodbyeChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Goodbye handler failed");
    }
  });

  // ── Boost ──────────────────────────────────────────────────────────────────
  client.on("guildMemberUpdate", async (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
    try {
      const wasBoosting = oldMember.premiumSince !== null;
      const isBoosting = newMember.premiumSince !== null;
      if (wasBoosting || !isBoosting) return;

      const settings = await getSettings(newMember.guild.id);
      if (!settings?.boosterChannelId) return;

      const msg = formatMessage(settings.boosterMessage, {
        user: `<@${newMember.id}>`,
        username: newMember.user.username,
        server: newMember.guild.name,
        boostCount: String(newMember.guild.premiumSubscriptionCount ?? 0),
        boostLevel: String(newMember.guild.premiumTier),
      });

      const embed = new EmbedBuilder()
        .setColor(0xff73fa)
        .setTitle("🚀 New Server Boost!")
        .setDescription(msg)
        .setThumbnail(newMember.user.displayAvatarURL())
        .addFields(
          { name: "Total Boosts", value: String(newMember.guild.premiumSubscriptionCount ?? 0), inline: true },
          { name: "Boost Level", value: String(newMember.guild.premiumTier), inline: true }
        )
        .setTimestamp();

      await sendToChannel(client, settings.boosterChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Boost handler failed");
    }
  });

  // ── Message Delete (Snipe Log) ─────────────────────────────────────────────
  client.on("messageDelete", async (message: Message | PartialMessage) => {
    if (message.author?.bot || !message.guild) return;
    try {
      const settings = await getSettings(message.guild.id);
      if (!settings?.eventLogChannelId) return;

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("🗑️ Message Deleted")
        .addFields(
          { name: "Author", value: message.author ? `<@${message.author.id}> (${message.author.tag})` : "Unknown", inline: true },
          { name: "Channel", value: `<#${message.channel.id}>`, inline: true }
        )
        .setTimestamp();

      if (message.content) {
        embed.addFields({ name: "Content", value: message.content.slice(0, 1024) });
      }
      if (message.attachments.size > 0) {
        embed.addFields({ name: "Attachments", value: [...message.attachments.values()].map((a) => a.url).join("\n").slice(0, 1024) });
      }

      await sendToChannel(client, settings.eventLogChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Message delete log failed");
    }
  });

  // ── Message Edit ──────────────────────────────────────────────────────────
  client.on("messageUpdate", async (oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) => {
    if (newMessage.author?.bot || !newMessage.guild) return;
    if (oldMessage.content === newMessage.content) return;
    try {
      const settings = await getSettings(newMessage.guild.id);
      if (!settings?.eventLogChannelId) return;

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle("✏️ Message Edited")
        .addFields(
          { name: "Author", value: newMessage.author ? `<@${newMessage.author.id}> (${newMessage.author.tag})` : "Unknown", inline: true },
          { name: "Channel", value: `<#${newMessage.channel.id}>`, inline: true },
          { name: "Jump to Message", value: `[Click here](${newMessage.url})`, inline: true }
        )
        .setTimestamp();

      if (oldMessage.content) {
        embed.addFields({ name: "Before", value: oldMessage.content.slice(0, 1024) });
      }
      if (newMessage.content) {
        embed.addFields({ name: "After", value: newMessage.content.slice(0, 1024) });
      }

      await sendToChannel(client, settings.eventLogChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Message edit log failed");
    }
  });

  // ── Reaction Add (log + reaction roles) ──────────────────────────────────
  client.on("messageReactionAdd", async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    if (user.bot) return;
    const guild = reaction.message.guild;
    if (!guild) return;
    try {
      if (reaction.partial) await reaction.fetch().catch(() => null);

      // Reaction roles
      const rrRows = await db.select().from(reactionRolesTable).where(
        and(eq(reactionRolesTable.guildId, guild.id), eq(reactionRolesTable.messageId, reaction.message.id), eq(reactionRolesTable.emoji, reaction.emoji.toString()))
      );
      if (rrRows.length) {
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (member) for (const row of rrRows) await member.roles.add(row.roleId).catch(() => null);
      }

      // Log
      const settings = await getSettings(guild.id);
      if (!settings?.eventLogChannelId) return;
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("➕ Reaction Added")
        .addFields(
          { name: "User", value: `<@${user.id}>`, inline: true },
          { name: "Emoji", value: reaction.emoji.toString(), inline: true },
          { name: "Channel", value: `<#${reaction.message.channel.id}>`, inline: true },
          { name: "Message", value: reaction.message.url ? `[Jump](${reaction.message.url})` : "Unknown", inline: true }
        )
        .setTimestamp();
      await sendToChannel(client, settings.eventLogChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Reaction add handler failed");
    }
  });

  // ── Reaction Remove (log + reaction roles) ────────────────────────────────
  client.on("messageReactionRemove", async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    if (user.bot) return;
    const guild = reaction.message.guild;
    if (!guild) return;
    try {
      if (reaction.partial) await reaction.fetch().catch(() => null);

      // Reaction roles
      const rrRows = await db.select().from(reactionRolesTable).where(
        and(eq(reactionRolesTable.guildId, guild.id), eq(reactionRolesTable.messageId, reaction.message.id), eq(reactionRolesTable.emoji, reaction.emoji.toString()))
      );
      if (rrRows.length) {
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (member) for (const row of rrRows) await member.roles.remove(row.roleId).catch(() => null);
      }

      // Log
      const settings = await getSettings(guild.id);
      if (!settings?.eventLogChannelId) return;
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("➖ Reaction Removed")
        .addFields(
          { name: "User", value: `<@${user.id}>`, inline: true },
          { name: "Emoji", value: reaction.emoji.toString(), inline: true },
          { name: "Channel", value: `<#${reaction.message.channel.id}>`, inline: true },
          { name: "Message", value: reaction.message.url ? `[Jump](${reaction.message.url})` : "Unknown", inline: true }
        )
        .setTimestamp();
      await sendToChannel(client, settings.eventLogChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Reaction remove handler failed");
    }
  });

  // ── Channel Create ─────────────────────────────────────────────────────────
  client.on("channelCreate", async (channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    try {
      const settings = await getSettings(channel.guild.id);
      if (!settings?.eventLogChannelId) return;

      let executor = "Unknown";
      try {
        const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 1 });
        const entry = logs.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 5000 && entry.executor) {
          executor = `<@${entry.executor.id}> (${entry.executor.tag})`;
        }
      } catch {}

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("📢 Channel Created")
        .addFields(
          { name: "Channel", value: `<#${channel.id}> (${channel.name})`, inline: true },
          { name: "Type", value: ChannelType[channel.type] ?? "Unknown", inline: true },
          { name: "Created By", value: executor, inline: true }
        )
        .setTimestamp();

      await sendToChannel(client, settings.eventLogChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Channel create log failed");
    }
  });

  // ── Channel Delete ─────────────────────────────────────────────────────────
  client.on("channelDelete", async (channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    try {
      const settings = await getSettings(channel.guild.id);
      if (!settings?.eventLogChannelId) return;

      let executor = "Unknown";
      try {
        const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 });
        const entry = logs.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 5000 && entry.executor) {
          executor = `<@${entry.executor.id}> (${entry.executor.tag})`;
        }
      } catch {}

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("🗑️ Channel Deleted")
        .addFields(
          { name: "Channel", value: `#${channel.name}`, inline: true },
          { name: "Type", value: ChannelType[channel.type] ?? "Unknown", inline: true },
          { name: "Deleted By", value: executor, inline: true }
        )
        .setTimestamp();

      await sendToChannel(client, settings.eventLogChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Channel delete log failed");
    }
  });

  // ── Channel Update ─────────────────────────────────────────────────────────
  client.on("channelUpdate", async (oldChannel, newChannel) => {
    if (!("guild" in newChannel) || !newChannel.guild) return;
    if (!("name" in oldChannel) || !("name" in newChannel)) return;
    if (oldChannel.name === newChannel.name) return;
    try {
      const settings = await getSettings(newChannel.guild.id);
      if (!settings?.eventLogChannelId) return;

      let executor = "Unknown";
      try {
        const logs = await newChannel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelUpdate, limit: 1 });
        const entry = logs.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 5000 && entry.executor) {
          executor = `<@${entry.executor.id}> (${entry.executor.tag})`;
        }
      } catch {}

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle("✏️ Channel Updated")
        .addFields(
          { name: "Channel", value: `<#${newChannel.id}>`, inline: true },
          { name: "Old Name", value: oldChannel.name, inline: true },
          { name: "New Name", value: newChannel.name, inline: true },
          { name: "Updated By", value: executor, inline: true }
        )
        .setTimestamp();

      await sendToChannel(client, settings.eventLogChannelId, { embeds: [embed] });
    } catch (err) {
      logger.error({ err }, "Channel update log failed");
    }
  });

  // ── Status Role – Check on Presence Update ────────────────────────────────
  client.on("presenceUpdate", async (_old, newPresence) => {
    if (!newPresence.guild || !newPresence.member) return;
    const rules = getStatusRoles(newPresence.guild.id);
    if (!rules.length) return;
    try {
      const customStatus = newPresence.activities.find((a) => a.type === 4)?.state?.toLowerCase() ?? "";
      const member = newPresence.member;
      for (const rule of rules) {
        const hasRole = member.roles.cache.has(rule.roleId);
        const matches = customStatus.includes(rule.keyword);
        if (matches && !hasRole) {
          await member.roles.add(rule.roleId).catch(() => null);
        } else if (!matches && hasRole) {
          await member.roles.remove(rule.roleId).catch(() => null);
        }
      }
    } catch (err) { logger.error({ err }, "Status role update failed"); }
  });

  // ── Ticket Button Interaction ─────────────────────────────────────────────
  client.on("interactionCreate", async (interaction: Interaction) => {
    if (!interaction.isButton() || interaction.customId !== "ticket_create") return;
    if (!interaction.guild) return;
    const guild = interaction.guild;
    const user = interaction.user;
    const ticketKey = `${guild.id}:${user.id}`;

    if (openTickets.has(ticketKey)) {
      const existingChId = openTickets.get(ticketKey)!;
      await interaction.reply({ content: `You already have an open ticket: <#${existingChId}>`, ephemeral: true });
      return;
    }

    try {
      const data = ticketStore.get(guild.id) ?? { managerRoles: [] };
      const overwrites: any[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ];
      for (const roleId of data.managerRoles) {
        overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }
      const ticketChannel = await guild.channels.create({
        name: `ticket-${user.username.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
        type: ChannelType.GuildText,
        parent: data.openedCategoryId,
        permissionOverwrites: overwrites,
      });
      openTickets.set(ticketKey, ticketChannel.id);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🎫 Ticket Opened")
        .setDescription(`Hello <@${user.id}>! Support will be with you shortly.\n\nDescribe your issue and a staff member will assist you.\nUse \`-ticket close\` to close this ticket.`)
        .setTimestamp();
      const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ticket_close_btn").setLabel("🔒 Close Ticket").setStyle(ButtonStyle.Danger)
      );
      await ticketChannel.send({ content: `<@${user.id}>`, embeds: [embed], components: [closeRow] });
      await interaction.reply({ content: `Your ticket has been created: ${ticketChannel}`, ephemeral: true });
    } catch (err) {
      logger.error({ err }, "Ticket creation failed");
      await interaction.reply({ content: "Failed to create ticket. Please try again.", ephemeral: true });
    }
  });

  // ── Ticket Close Button ───────────────────────────────────────────────────
  client.on("interactionCreate", async (interaction: Interaction) => {
    if (!interaction.isButton() || interaction.customId !== "ticket_close_btn") return;
    if (!interaction.guild) return;
    try {
      await interaction.reply({ content: "Closing ticket in 5 seconds...", ephemeral: true }).catch(() => null);
      const ticketKey = [...openTickets.entries()].find(([, chId]) => chId === interaction.channel?.id)?.[0];
      if (ticketKey) openTickets.delete(ticketKey);
      setTimeout(() => interaction.channel?.delete().catch(() => null), 5000);
    } catch (err) {
      logger.error({ err }, "Ticket close button failed");
    }
  });

  logger.info({ tag: "engagement" }, "Engagement handlers registered");
}
