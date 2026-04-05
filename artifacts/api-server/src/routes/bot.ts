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
    const botGuilds = client.guilds.cache;

    if (req.session?.user?.accessToken) {
      const userGuildsRes = await fetch("https://discord.com/api/v10/users/@me/guilds", {
        headers: { Authorization: `Bearer ${req.session.user.accessToken}` },
      });

      if (userGuildsRes.ok) {
        const userGuilds = (await userGuildsRes.json()) as Array<{ id: string }>;
        const userGuildIds = new Set(userGuilds.map((g) => g.id));

        const sharedGuilds = botGuilds
          .filter((g) => userGuildIds.has(g.id))
          .map((g) => ({
            id: g.id,
            name: g.name,
            icon: g.icon,
            memberCount: g.memberCount,
            ownerId: g.ownerId,
          }));

        return res.json(sharedGuilds);
      }
    }

    const guilds = botGuilds.map((g) => ({
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
