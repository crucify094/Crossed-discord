import { Router, type IRouter } from "express";
import { getDiscordClient } from "../lib/discord";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/guild/:guildId/commands", async (req, res) => {
  try {
    const { guildId } = req.params;
    const client = await getDiscordClient();

    const appCommands = await client.application!.commands.fetch();
    const guildCommands = await client.guilds.cache.get(guildId)?.commands.fetch();

    const disabledIds: string[] = [];
    try {
      const rows = await db.execute(
        sql`SELECT command_id FROM disabled_commands WHERE guild_id = ${guildId}`
      );
      for (const row of rows as unknown as any[]) {
        disabledIds.push(row.command_id);
      }
    } catch {
    }

    const globalList = appCommands.map((cmd) => ({
      id: cmd.id,
      name: cmd.name,
      description: cmd.description,
      type: cmd.type,
      scope: "global" as const,
      enabled: !disabledIds.includes(cmd.id),
      options: cmd.options?.map((o) => ({ name: o.name, description: o.description, type: o.type })) ?? [],
    }));

    const guildList = guildCommands
      ? guildCommands
          .filter((cmd) => !appCommands.has(cmd.id))
          .map((cmd) => ({
            id: cmd.id,
            name: cmd.name,
            description: cmd.description,
            type: cmd.type,
            scope: "guild" as const,
            enabled: !disabledIds.includes(cmd.id),
            options: cmd.options?.map((o) => ({ name: o.name, description: o.description, type: o.type })) ?? [],
          }))
      : [];

    res.json([...globalList, ...guildList]);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch commands");
    res.status(500).json({ error: "Failed to fetch commands" });
  }
});

router.patch("/guild/:guildId/commands/:commandId", async (req, res) => {
  try {
    const { guildId, commandId } = req.params;
    const { enabled } = req.body as { enabled: boolean };

    try {
      if (!enabled) {
        await db.execute(
          sql`INSERT INTO disabled_commands (guild_id, command_id) VALUES (${guildId}, ${commandId}) ON CONFLICT DO NOTHING`
        );
      } else {
        await db.execute(
          sql`DELETE FROM disabled_commands WHERE guild_id = ${guildId} AND command_id = ${commandId}`
        );
      }
    } catch {
    }

    res.json({ success: true, enabled });
  } catch (err) {
    req.log.error({ err }, "Failed to update command");
    res.status(500).json({ error: "Failed to update command" });
  }
});

export default router;
