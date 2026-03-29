import { Router, type IRouter } from "express";
import { getDiscordClient } from "../lib/discord";
import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/guild/:guildId/overview", async (req, res) => {
  try {
    const { guildId } = req.params;
    const client = await getDiscordClient();
    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
      res.status(404).json({ error: "Guild not found" }); return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(eq(auditLogsTable.guildId, guildId))
      .orderBy(desc(auditLogsTable.createdAt));

    const bansToday = logs.filter(
      (l) => l.type === "member_ban" && l.createdAt >= today
    ).length;
    const warningsToday = logs.filter(
      (l) => l.type === "member_warn" && l.createdAt >= today
    ).length;

    res.json({
      guildId,
      memberCount: guild.memberCount,
      onlineCount: 0,
      channelCount: guild.channels.cache.size,
      roleCount: guild.roles.cache.size,
      boostLevel: guild.premiumTier,
      boostCount: guild.premiumSubscriptionCount ?? 0,
      warningsToday,
      bansToday,
      messagesProcessed: logs.length,
      antinukeEnabled: false,
      antiraidEnabled: false,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get guild overview");
    res.status(500).json({ error: "Failed to get guild overview" });
  }
});

router.get("/guild/:guildId/channels", async (req, res) => {
  try {
    const { guildId } = req.params;
    const client = await getDiscordClient();
    const guild = client.guilds.cache.get(guildId);

    if (!guild) return res.status(404).json({ error: "Guild not found" });

    const channelTypeMap: Record<number, string> = {
      0: "text",
      2: "voice",
      4: "category",
      5: "announcement",
      15: "forum",
      13: "stage",
    };

    const channels = guild.channels.cache.map((c) => ({
      id: c.id,
      name: c.name,
      type: channelTypeMap[c.type as number] ?? "text",
    }));

    res.json(channels);
  } catch (err) {
    req.log.error({ err }, "Failed to get channels");
    res.status(500).json({ error: "Failed to get channels" });
  }
});

router.get("/guild/:guildId/roles", async (req, res) => {
  try {
    const { guildId } = req.params;
    const client = await getDiscordClient();
    const guild = client.guilds.cache.get(guildId);

    if (!guild) return res.status(404).json({ error: "Guild not found" });

    const roles = guild.roles.cache
      .filter((r) => r.name !== "@everyone")
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        position: r.position,
      }))
      .sort((a, b) => b.position - a.position);

    res.json(roles);
  } catch (err) {
    req.log.error({ err }, "Failed to get roles");
    res.status(500).json({ error: "Failed to get roles" });
  }
});

export default router;
