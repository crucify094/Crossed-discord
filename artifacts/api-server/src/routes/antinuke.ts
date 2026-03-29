import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { antinukeSettingsTable, antinukeWhitelistTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

const defaultSettings = {
  enabled: false,
  maxChannelDeletes: 3,
  maxBans: 3,
  maxKicks: 5,
  maxRoleDeletes: 3,
  maxWebhookCreates: 5,
  intervalSeconds: 10,
  action: "strip_roles" as const,
  logChannelId: null,
  dmOwner: true,
};

router.get("/guild/:guildId/antinuke", async (req, res) => {
  try {
    const { guildId } = req.params;
    const [settings] = await db
      .select()
      .from(antinukeSettingsTable)
      .where(eq(antinukeSettingsTable.guildId, guildId));

    if (!settings) {
      return res.json({ ...defaultSettings, guildId });
    }

    res.json(settings);
  } catch (err) {
    req.log.error({ err }, "Failed to get antinuke settings");
    res.status(500).json({ error: "Failed to get settings" });
  }
});

router.put("/guild/:guildId/antinuke", async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body;

    const existing = await db
      .select()
      .from(antinukeSettingsTable)
      .where(eq(antinukeSettingsTable.guildId, guildId));

    let result;
    if (existing.length === 0) {
      [result] = await db
        .insert(antinukeSettingsTable)
        .values({ guildId, ...body })
        .returning();
    } else {
      [result] = await db
        .update(antinukeSettingsTable)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(antinukeSettingsTable.guildId, guildId))
        .returning();
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to update antinuke settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

router.get("/guild/:guildId/antinuke/whitelist", async (req, res) => {
  try {
    const { guildId } = req.params;
    const entries = await db
      .select()
      .from(antinukeWhitelistTable)
      .where(eq(antinukeWhitelistTable.guildId, guildId));
    res.json(entries);
  } catch (err) {
    req.log.error({ err }, "Failed to get whitelist");
    res.status(500).json({ error: "Failed to get whitelist" });
  }
});

router.post("/guild/:guildId/antinuke/whitelist", async (req, res) => {
  try {
    const { guildId } = req.params;
    const { targetId, targetType, targetName } = req.body;

    const [entry] = await db
      .insert(antinukeWhitelistTable)
      .values({ guildId, targetId, targetType, targetName })
      .returning();

    res.status(201).json(entry);
  } catch (err) {
    req.log.error({ err }, "Failed to add whitelist entry");
    res.status(500).json({ error: "Failed to add to whitelist" });
  }
});

router.delete("/guild/:guildId/antinuke/whitelist/:entryId", async (req, res) => {
  try {
    const { guildId, entryId } = req.params;
    await db
      .delete(antinukeWhitelistTable)
      .where(
        and(
          eq(antinukeWhitelistTable.guildId, guildId),
          eq(antinukeWhitelistTable.id, parseInt(entryId))
        )
      );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to remove whitelist entry");
    res.status(500).json({ error: "Failed to remove from whitelist" });
  }
});

export default router;
