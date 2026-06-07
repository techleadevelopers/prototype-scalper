import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import router from "./routes";
import { logger } from "./lib/logger";
import { exportAllOutcomes, initTelemetryStore } from "./lib/telemetryStore";
import { startQuantBrainOutcomeSync } from "./lib/quantBrainClient";

// Initialize adaptive engine from persisted telemetry on startup
initTelemetryStore();
startQuantBrainOutcomeSync(exportAllOutcomes());
logger.info("Adaptive telemetry engine initialized");

const app: Express = express();
const isProduction =
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);

function allowedFrontendOrigins(): string[] {
  const configured = [
    process.env.FRONTEND_URL,
    ...(process.env.FRONTEND_URLS ?? "").split(","),
  ];
  return configured
    .map((origin) => origin?.trim().replace(/\/+$/, ""))
    .filter((origin): origin is string => Boolean(origin));
}

const frontendOrigins = allowedFrontendOrigins();

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
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    const normalized = origin.replace(/\/+$/, "");
    if (!isProduction || frontendOrigins.includes(normalized)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS origin not allowed: ${origin}`));
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionSecret = process.env.SESSION_SECRET ?? "bingx-dashboard-secret-change-me";

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
