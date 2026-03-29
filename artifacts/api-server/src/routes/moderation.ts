import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { automodSettingsTable, jailSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/guild/:guildId/moderation/automod", async (req, res) => {
  try {
    const { guildId } = req.params;
    const [settings] = await db
      .select()
      .from(automodSettingsTable)
      .where(eq(automodSettingsTable.guildId, guildId));

    res.json(
      settings ?? {
        enabled: false,
        filterInvites: false,
        filterLinks: false,
        filterSpam: false,
        filterCaps: false,
        capsThreshold: 70,
        filterMentionSpam: false,
        maxMentions: 5,
        filterWords: false,
        bannedWords: [],
        spamAction: "delete",
        logChannelId: null,
        guildId,
      }
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get automod settings");
    res.status(500).json({ error: "Failed to get settings" });
  }
});

router.put("/guild/:guildId/moderation/automod", async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body;

    const existing = await db
      .select()
      .from(automodSettingsTable)
      .where(eq(automodSettingsTable.guildId, guildId));

    let result;
    if (existing.length === 0) {
      [result] = await db
        .insert(automodSettingsTable)
        .values({ guildId, ...body })
        .returning();
    } else {
      [result] = await db
        .update(automodSettingsTable)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(automodSettingsTable.guildId, guildId))
        .returning();
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to update automod settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

router.get("/guild/:guildId/moderation/jail", async (req, res) => {
  try {
    const { guildId } = req.params;
    const [settings] = await db
      .select()
      .from(jailSettingsTable)
      .where(eq(jailSettingsTable.guildId, guildId));

    res.json(
      settings ?? {
        enabled: false,
        jailChannelId: null,
        jailRoleId: null,
        logChannelId: null,
        guildId,
      }
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get jail settings");
    res.status(500).json({ error: "Failed to get settings" });
  }
});

router.put("/guild/:guildId/moderation/jail", async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body;

    const existing = await db
      .select()
      .from(jailSettingsTable)
      .where(eq(jailSettingsTable.guildId, guildId));

    let result;
    if (existing.length === 0) {
      [result] = await db
        .insert(jailSettingsTable)
        .values({ guildId, ...body })
        .returning();
    } else {
      [result] = await db
        .update(jailSettingsTable)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(jailSettingsTable.guildId, guildId))
        .returning();
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to update jail settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;
