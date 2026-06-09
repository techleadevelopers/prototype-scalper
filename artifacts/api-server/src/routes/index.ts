import { Router, type IRouter } from "express";
import healthRouter from "./health";
import bingxRouter from "./bingx";
import botRouter from "./bot";
import telemetryRouter from "./telemetry";
import demoRouter from "./demo";
import executionRouter from "./execution";
import pipelineRouter from "./pipeline";
import strategyMemoryRouter from "./strategyMemory";
import liveReadinessRouter from "./liveReadiness";
import killSwitchRouter from "./killSwitch";
import scoreCalibrationRouter from "./scoreCalibration";
import incidentsRouter from "./incidents";
import sniperGovernanceRouter from "./sniperGovernance";
import policyRouter from "./policy";
import triggerRouter from "./trigger";

const router: IRouter = Router();

router.use(healthRouter);
router.use(bingxRouter);
router.use(botRouter);
router.use(telemetryRouter);
router.use(demoRouter);
router.use(executionRouter);
router.use(pipelineRouter);
router.use(strategyMemoryRouter);
router.use(liveReadinessRouter);
router.use(killSwitchRouter);
router.use(scoreCalibrationRouter);
router.use(incidentsRouter);
router.use(sniperGovernanceRouter);
router.use(policyRouter);
router.use(triggerRouter);

export default router;
