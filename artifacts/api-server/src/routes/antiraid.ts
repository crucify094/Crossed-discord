import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { antiraidSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const defaultSettings = {
  enabled: false,
  joinRateLimit: 10,
  joinRateInterval: 10,
  action: "kick" as const,
  filterNoAvatar: true,
  filterNewAccounts: false,
  minAccountAgeDays: 7,
  lockdownEnabled: false,
  logChannelId: null,
};

router.get("/guild/:guildId/antiraid", async (req, res) => {
  try {
    const { guildId } = req.params;
    const [settings] = await db
      .select()
      .from(antiraidSettingsTable)
      .where(eq(antiraidSettingsTable.guildId, guildId));

    res.json(settings ?? { ...defaultSettings, guildId });
  } catch (err) {
    req.log.error({ err }, "Failed to get antiraid settings");
    res.status(500).json({ error: "Failed to get settings" });
  }
});

router.put("/guild/:guildId/antiraid", async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body;

    const existing = await db
      .select()
      .from(antiraidSettingsTable)
      .where(eq(antiraidSettingsTable.guildId, guildId));

    let result;
    if (existing.length === 0) {
      [result] = await db
        .insert(antiraidSettingsTable)
        .values({ guildId, ...body })
        .returning();
    } else {
      [result] = await db
        .update(antiraidSettingsTable)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(antiraidSettingsTable.guildId, guildId))
        .returning();
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to update antiraid settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;
