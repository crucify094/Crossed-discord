import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  reactionRolesTable,
  welcomeSettingsTable,
  socialAlertsTable,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

// Reaction Roles
router.get("/guild/:guildId/reaction-roles", async (req, res) => {
  try {
    const { guildId } = req.params;
    const roles = await db
      .select()
      .from(reactionRolesTable)
      .where(eq(reactionRolesTable.guildId, guildId));
    res.json(roles);
  } catch (err) {
    req.log.error({ err }, "Failed to get reaction roles");
    res.status(500).json({ error: "Failed to get reaction roles" });
  }
});

router.post("/guild/:guildId/reaction-roles", async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body;
    const [role] = await db
      .insert(reactionRolesTable)
      .values({ guildId, ...body })
      .returning();
    res.status(201).json(role);
  } catch (err) {
    req.log.error({ err }, "Failed to create reaction role");
    res.status(500).json({ error: "Failed to create reaction role" });
  }
});

router.delete("/guild/:guildId/reaction-roles/:roleId", async (req, res) => {
  try {
    const { guildId, roleId } = req.params;
    await db
      .delete(reactionRolesTable)
      .where(
        and(
          eq(reactionRolesTable.guildId, guildId),
          eq(reactionRolesTable.id, parseInt(roleId))
        )
      );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete reaction role");
    res.status(500).json({ error: "Failed to delete reaction role" });
  }
});

// Welcome Settings
router.get("/guild/:guildId/welcome", async (req, res) => {
  try {
    const { guildId } = req.params;
    const [settings] = await db
      .select()
      .from(welcomeSettingsTable)
      .where(eq(welcomeSettingsTable.guildId, guildId));

    res.json(
      settings ?? {
        welcomeEnabled: false,
        welcomeChannelId: null,
        welcomeMessage: "Welcome to the server, {user}!",
        welcomeEmbed: false,
        goodbyeEnabled: false,
        goodbyeChannelId: null,
        goodbyeMessage: "Goodbye, {user}. We'll miss you!",
        dmWelcome: false,
        dmMessage: "Welcome to {server}! Enjoy your stay.",
        guildId,
      }
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get welcome settings");
    res.status(500).json({ error: "Failed to get settings" });
  }
});

router.put("/guild/:guildId/welcome", async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body;

    const existing = await db
      .select()
      .from(welcomeSettingsTable)
      .where(eq(welcomeSettingsTable.guildId, guildId));

    let result;
    if (existing.length === 0) {
      [result] = await db
        .insert(welcomeSettingsTable)
        .values({ guildId, ...body })
        .returning();
    } else {
      [result] = await db
        .update(welcomeSettingsTable)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(welcomeSettingsTable.guildId, guildId))
        .returning();
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to update welcome settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// Social Alerts
router.get("/guild/:guildId/social-alerts", async (req, res) => {
  try {
    const { guildId } = req.params;
    const alerts = await db
      .select()
      .from(socialAlertsTable)
      .where(eq(socialAlertsTable.guildId, guildId));
    res.json(alerts);
  } catch (err) {
    req.log.error({ err }, "Failed to get social alerts");
    res.status(500).json({ error: "Failed to get social alerts" });
  }
});

router.post("/guild/:guildId/social-alerts", async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body;
    const [alert] = await db
      .insert(socialAlertsTable)
      .values({ guildId, ...body })
      .returning();
    res.status(201).json(alert);
  } catch (err) {
    req.log.error({ err }, "Failed to create social alert");
    res.status(500).json({ error: "Failed to create social alert" });
  }
});

router.delete("/guild/:guildId/social-alerts/:alertId", async (req, res) => {
  try {
    const { guildId, alertId } = req.params;
    await db
      .delete(socialAlertsTable)
      .where(
        and(
          eq(socialAlertsTable.guildId, guildId),
          eq(socialAlertsTable.id, parseInt(alertId))
        )
      );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete social alert");
    res.status(500).json({ error: "Failed to delete social alert" });
  }
});

export default router;
