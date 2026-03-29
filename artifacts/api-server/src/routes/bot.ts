import { Router, type IRouter } from "express";
import { getDiscordClient } from "../lib/discord";

const router: IRouter = Router();

router.get("/bot/info", async (req, res) => {
  try {
    const client = await getDiscordClient();
    const user = client.user!;
    res.json({
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
      banner: null,
      bio: null,
      guildCount: client.guilds.cache.size,
      status: "online",
      ping: Math.round(client.ws.ping),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get bot info");
    res.status(500).json({ error: "Failed to connect to Discord" });
  }
});

router.get("/bot/guilds", async (req, res) => {
  try {
    const client = await getDiscordClient();
    const guilds = client.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      memberCount: g.memberCount,
      ownerId: g.ownerId,
    }));
    res.json(guilds);
  } catch (err) {
    req.log.error({ err }, "Failed to get guilds");
    res.status(500).json({ error: "Failed to connect to Discord" });
  }
});

export default router;
