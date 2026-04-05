import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import botRouter from "./bot";
import guildRouter from "./guild";
import antinukeRouter from "./antinuke";
import antiraidRouter from "./antiraid";
import moderationRouter from "./moderation";
import levelingRouter from "./leveling";
import engagementRouter from "./engagement";
import logsRouter from "./logs";
import commandsRouter from "./commands";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(botRouter);
router.use(guildRouter);
router.use(antinukeRouter);
router.use(antiraidRouter);
router.use(moderationRouter);
router.use(levelingRouter);
router.use(engagementRouter);
router.use(logsRouter);
router.use(commandsRouter);

export default router;
