import { Client, GatewayIntentBits, ActivityType } from "discord.js";
import { logger } from "./logger";

let client: Client | null = null;
let loginPromise: Promise<Client> | null = null;

function setRichPresence(readyClient: Client) {
  readyClient.user?.setPresence({
    status: "online",
    activities: [
      {
        name: "Server security and management",
        type: ActivityType.Streaming,
        url: "https://discord.gg/uHuZVs8tHC",
      },
    ],
  });
}

export async function getDiscordClient(): Promise<Client> {
  if (client && client.isReady()) {
    return client;
  }

  if (loginPromise) {
    return loginPromise;
  }

  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }

  // In development, only connect the bot if explicitly enabled.
  // This prevents the dev server and the published production server
  // from both responding to every Discord message with duplicate embeds.
  const isDev = process.env["NODE_ENV"] === "development";
  const botEnabled = process.env["DISCORD_BOT_ENABLED"] === "true";
  if (isDev && !botEnabled) {
    throw new Error(
      "Bot is disabled in development (set DISCORD_BOT_ENABLED=true to enable locally)"
    );
  }

  loginPromise = (async () => {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    await client.login(token);

    return new Promise<Client>((resolve, reject) => {
      if (!client) return reject(new Error("Client not initialized"));
      if (client.isReady()) return resolve(client);

      const timeout = setTimeout(() => {
        loginPromise = null;
        reject(new Error("Discord login timeout after 20s"));
      }, 20000);

      client.on("error", (err) => {
        logger.error({ err, tag: "discord" }, "Discord client runtime error");
      });

      client.on("warn", (info) => {
        logger.warn({ info, tag: "discord" }, "Discord client warning");
      });

      client.once("ready", async (readyClient) => {
        clearTimeout(timeout);
        loginPromise = null;
        logger.info({ tag: "discord", guilds: readyClient.guilds.cache.size }, "Discord client ready");

        setRichPresence(readyClient);

        setInterval(() => setRichPresence(readyClient), 30 * 60 * 1000);

        try {
          const { registerPrefixHandler } = await import("./prefixCommands");
          registerPrefixHandler(readyClient);
          logger.info({ tag: "discord" }, "Prefix command handler registered");
        } catch (err) {
          logger.error({ err, tag: "discord" }, "Failed to register prefix handler");
        }

        try {
          const { registerAutoModHandlers } = await import("./automod");
          registerAutoModHandlers(readyClient);
          logger.info({ tag: "discord" }, "Auto-mod handlers registered");
        } catch (err) {
          logger.error({ err, tag: "discord" }, "Failed to register auto-mod handlers");
        }

        try {
          const { registerEngagementHandlers } = await import("./engagement");
          registerEngagementHandlers(readyClient);
          logger.info({ tag: "discord" }, "Engagement handlers registered");
        } catch (err) {
          logger.error({ err, tag: "discord" }, "Failed to register engagement handlers");
        }

        resolve(readyClient);
      });

      client.once("error", (err) => {
        clearTimeout(timeout);
        loginPromise = null;
        logger.error({ err, tag: "discord" }, "Discord client error on login");
        reject(err);
      });
    });
  })();

  return loginPromise;
}

export function getClientIfReady(): Client | null {
  if (client && client.isReady()) return client;
  return null;
}
