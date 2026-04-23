import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";
import { getDiscordClient } from "./lib/discord";

const app: Express = express();

app.use(
  session({
    secret: process.env["SESSION_SECRET"] || "bleed-dashboard-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env["NODE_ENV"] === "production",
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
      sameSite: "lax",
    },
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", router);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(__dirname, "../../discord-dashboard/dist/public"),
  path.resolve(__dirname, "../../../artifacts/discord-dashboard/dist/public"),
  path.resolve(process.cwd(), "artifacts/discord-dashboard/dist/public"),
];
const dashboardDist = candidates.find((p) => existsSync(p));

if (dashboardDist) {
  logger.info({ dashboardDist }, "Serving dashboard static files");
  app.use(express.static(dashboardDist));
  app.get(/^(?!\/api\/|\/healthz).*/, (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
} else {
  logger.warn(
    { candidates },
    "Dashboard build not found; only API routes will be served",
  );
}

getDiscordClient().catch((err) => {
  logger.error({ err, tag: "app" }, "Failed to initialize Discord client");
});

export default app;
