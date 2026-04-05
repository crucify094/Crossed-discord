import { Router } from "express";
import { logger } from "../lib/logger";

const router: Router = Router();
const DISCORD_API = "https://discord.com/api/v10";

function getRedirectUri(): string {
  const domain = process.env["REPLIT_DEV_DOMAIN"];
  if (domain) return `https://${domain}/api/auth/discord/callback`;
  const port = process.env["PORT"] || 8080;
  return `http://localhost:${port}/api/auth/discord/callback`;
}

function getFrontendUrl(): string {
  const domain = process.env["REPLIT_DEV_DOMAIN"];
  if (domain) return `https://${domain}`;
  return "http://localhost:3000";
}

router.get("/auth/discord", (req, res) => {
  const clientId = process.env["DISCORD_CLIENT_ID"];
  if (!clientId) {
    return res.status(500).json({ error: "DISCORD_CLIENT_ID is not configured" });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: "identify guilds",
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

router.get("/auth/discord/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${getFrontendUrl()}?error=access_denied`);
  }

  const clientId = process.env["DISCORD_CLIENT_ID"];
  const clientSecret = process.env["DISCORD_CLIENT_SECRET"];

  if (!clientId || !clientSecret) {
    return res.redirect(`${getFrontendUrl()}?error=config_error`);
  }

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: getRedirectUri(),
      }),
    });

    const tokenData = (await tokenRes.json()) as Record<string, unknown>;
    if (!tokenRes.ok) {
      logger.error({ tokenData }, "Discord token exchange failed");
      throw new Error("Token exchange failed");
    }

    const accessToken = tokenData["access_token"] as string;

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = (await userRes.json()) as Record<string, unknown>;

    if (!userRes.ok) throw new Error("Failed to fetch user info");

    const userId = user["id"] as string;
    const avatar = user["avatar"] as string | null;

    req.session.user = {
      id: userId,
      username: (user["global_name"] as string) || (user["username"] as string),
      discriminator: (user["discriminator"] as string) || "0",
      avatar: avatar
        ? `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(userId) % 5}.png`,
      accessToken,
    };

    res.redirect(getFrontendUrl());
  } catch (err) {
    logger.error({ err }, "Discord OAuth callback failed");
    res.redirect(`${getFrontendUrl()}?error=auth_failed`);
  }
});

router.get("/auth/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const { accessToken: _token, ...safeUser } = req.session.user;
  res.json(safeUser);
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error({ err }, "Session destroy failed");
      return res.status(500).json({ error: "Logout failed" });
    }
    res.json({ success: true });
  });
});

export default router;
