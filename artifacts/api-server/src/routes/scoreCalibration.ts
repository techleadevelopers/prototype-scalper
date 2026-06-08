import { Router, type Request, type Response } from "express";
import { getQuantBrainScoreCalibrationStatus } from "../lib/quantBrainClient";

const router = Router();

router.get("/score-calibration/status", async (req: Request, res: Response) => {
  const days = Number(req.query.days ?? 30);
  const limit = Number(req.query.limit ?? 5000);
  try {
    const status = await getQuantBrainScoreCalibrationStatus(days, limit);
    res.json(status);
  } catch (error) {
    res.status(503).json({
      connected: false,
      error: error instanceof Error ? error.message : "score_calibration_unavailable",
      buckets: [],
      scoreTruth: {
        isMonotonic: false,
        calibrationQuality: "INSUFFICIENT_DATA",
        overconfidence: false,
        bestBucket: null,
        toxicBucket: null,
        recommendedMinScore: 0.58,
        recommendedBoostScore: 0.76,
      },
      recommendedThresholds: {
        minAggressiveScore: 0.58,
        minStackingScore: 0.68,
        minBoostScore: 0.76,
        maxSniperScore: 0.92,
      },
      overconfidenceWarnings: ["score_calibration_unavailable"],
      bestScoringModel: null,
      scoreVsActualPnlChartData: [],
    });
  }
});

export default router;
