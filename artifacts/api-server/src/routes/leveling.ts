import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { levelingSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/guild/:guildId/leveling", async (req, res) => {
  try {
    const { guildId } = req.params;
    const [settings] = await db
      .select()
      .from(levelingSettingsTable)
      .where(eq(levelingSettingsTable.guildId, guildId));

    res.json(
      settings ?? {
        enabled: false,
        xpPerMessage: 15,
        xpCooldownSeconds: 60,
        levelUpMessage: "GG {user}, you just reached level {level}!",
        levelUpChannelId: null,
        ignoredChannels: [],
        ignoredRoles: [],
        stackRoles: false,
        levelRoles: [],
        guildId,
      }
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get leveling settings");
    res.status(500).json({ error: "Failed to get settings" });
  }
});

router.put("/guild/:guildId/leveling", async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body;

    const existing = await db
      .select()
      .from(levelingSettingsTable)
      .where(eq(levelingSettingsTable.guildId, guildId));

    let result;
    if (existing.length === 0) {
      [result] = await db
        .insert(levelingSettingsTable)
        .values({ guildId, ...body })
        .returning();
    } else {
      [result] = await db
        .update(levelingSettingsTable)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(levelingSettingsTable.guildId, guildId))
        .returning();
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to update leveling settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;
