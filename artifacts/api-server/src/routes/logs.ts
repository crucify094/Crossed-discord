import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/guild/:guildId/logs", async (req, res) => {
  try {
    const { guildId } = req.params;
    const limit = parseInt(req.query["limit"] as string) || 50;
    const type = req.query["type"] as string | undefined;

    const whereClause = type
      ? and(eq(auditLogsTable.guildId, guildId), eq(auditLogsTable.type, type as any))
      : eq(auditLogsTable.guildId, guildId);

    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(whereClause)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(limit);

    res.json(logs);
  } catch (err) {
    req.log.error({ err }, "Failed to get audit logs");
    res.status(500).json({ error: "Failed to get audit logs" });
  }
});

export default router;
