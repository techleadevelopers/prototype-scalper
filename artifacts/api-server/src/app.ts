import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import router from "./routes";
import { logger } from "./lib/logger";
import { initTelemetryStore, exportAllOutcomes } from "./lib/telemetryStore";
import { startQuantBrainOutcomeSync } from "./lib/quantBrainClient";
import { startLivePositionWatcher } from "./lib/livePositionWatcher";
import { beginRequestMeasurement } from "./lib/runtimeMetrics";
import { validateExecutionStartup } from "./lib/executionSecurity";

const execution = validateExecutionStartup();
initTelemetryStore();
startQuantBrainOutcomeSync(
  exportAllOutcomes().filter(
    (outcome) => outcome.source !== "bingx-vst" || outcome.id.startsWith("campaign:"),
  ),
);
if (execution.environment === "live") startLivePositionWatcher();
logger.info("Adaptive telemetry engine initialized");

const app: Express = express();

const isProduction =
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);

if (isProduction) {
  app.set("trust proxy", 1);
}

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
const corsOriginConfig = process.env.CORS_ORIGIN ?? process.env.FRONTEND_URLS ?? process.env.FRONTEND_URL ?? "";
const allowedOrigins = corsOriginConfig.split(",").map((s) => s.trim()).filter(Boolean);

if (isProduction && allowedOrigins.length === 0) {
  logger.error("FATAL: CORS_ORIGIN or FRONTEND_URLS must be set in production.");
  process.exit(1);
}

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (!isProduction && allowedOrigins.length === 0) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error("CORS: origin not allowed"));
    },
  }),
);
app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT ?? "256kb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.REQUEST_BODY_LIMIT ?? "256kb" }));
app.use((_req, res, next) => {
  const finish = beginRequestMeasurement();
  res.once("finish", finish);
  next();
});

const SESSION_SECRET_DEFAULT = "bingx-dashboard-secret-change-me";
const sessionSecret = process.env.SESSION_SECRET ?? SESSION_SECRET_DEFAULT;

if (isProduction && sessionSecret === SESSION_SECRET_DEFAULT) {
  logger.error(
    "FATAL: SESSION_SECRET env var must be set in production. " +
    "Set a strong random secret via the Replit Secrets panel.",
  );
  process.exit(1);
}

if (!isProduction && sessionSecret === SESSION_SECRET_DEFAULT) {
  logger.warn(
    "SESSION_SECRET is using the insecure dev default. " +
    "Set SESSION_SECRET env var before deploying to production.",
  );
}

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: isProduction,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  }),
);

app.use("/api", router);

export default app;
