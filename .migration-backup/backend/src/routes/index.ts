import { Router, type IRouter } from "express";
import healthRouter from "./health";
import bingxRouter from "./bingx";
import botRouter from "./bot";
import telemetryRouter from "./telemetry";
import demoRouter from "./demo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(bingxRouter);
router.use(botRouter);
router.use(telemetryRouter);
router.use(demoRouter);

export default router;
