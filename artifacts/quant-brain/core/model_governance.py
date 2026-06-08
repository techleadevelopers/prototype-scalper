from __future__ import annotations

import hashlib
import json
import math
import random
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable


MODEL_KINDS = {
    "deterministic_baseline",
    "current_champion",
    "ml_challenger",
    "stacking_policy_challenger",
    "early_exit_shadow_challenger",
}
MODEL_STATES = {"shadow", "review", "champion", "retired"}


@dataclass(frozen=True)
class VersionSet:
    feature: str
    label: str
    policy: str

    def validate(self) -> None:
        for name, value in asdict(self).items():
            if not value or value.strip().lower() in {"latest", "unknown"}:
                raise ValueError(f"{name} version must be explicit and immutable")


@dataclass(frozen=True)
class CandidateSpec:
    candidate_id: str
    kind: str
    versions: VersionSet
    artifact_sha256: str
    created_at: float
    parent_candidate_id: str | None = None
    state: str = "shadow"
    frozen: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        if self.kind not in MODEL_KINDS:
            raise ValueError(f"unsupported model kind: {self.kind}")
        if self.state not in MODEL_STATES:
            raise ValueError(f"unsupported model state: {self.state}")
        self.versions.validate()
        if len(self.artifact_sha256) != 64:
            raise ValueError("artifact_sha256 must be a SHA-256 digest")


@dataclass(frozen=True)
class CampaignObservation:
    candidate_id: str
    campaign_id: str
    observed_at: float
    label_end_at: float
    symbol: str
    side: str
    regime: str
    net_vst: float
    candidate_accepted: bool
    baseline_accepted: bool
    champion_accepted: bool
    operational_ok: bool = True
    predicted_probability: float | None = None
    outcome: int | None = None

    def validate(self) -> None:
        if self.label_end_at < self.observed_at:
            raise ValueError("label_end_at cannot precede observed_at")
        if not self.campaign_id:
            raise ValueError("campaign_id is required")
        if self.side not in {"LONG", "SHORT"}:
            raise ValueError("side must be LONG or SHORT")
        if self.predicted_probability is not None:
            if not 0 <= self.predicted_probability <= 1:
                raise ValueError("predicted_probability must be in [0, 1]")
            if self.outcome not in {0, 1}:
                raise ValueError("binary outcome is required with a prediction")


@dataclass(frozen=True)
class GovernanceThresholds:
    min_campaigns: int = 30
    min_symbols: int = 3
    min_sides: int = 2
    min_regimes: int = 2
    walk_forward_folds: int = 4
    purge_gap_seconds: float = 300.0
    final_test_fraction: float = 0.20
    bootstrap_samples: int = 1000
    confidence_level: float = 0.95
    min_expectancy_vst: float = 0.0
    min_uplift_vst: float = 0.0
    max_drawdown_vst: float = 5.0
    max_brier: float = 0.25
    max_calibration_error: float = 0.10
    min_operational_reliability: float = 0.98
    monitoring_min_campaigns: int = 10


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(_canonical_json(value))
    temporary.replace(path)


class GovernanceStore:
    """Content-addressed artifacts plus an append-only transition audit."""

    def __init__(self, root: Path):
        self.root = root
        self.artifacts_dir = root / "artifacts"
        self.evidence_dir = root / "evidence"
        self.registry_path = root / "registry.json"
        self.audit_path = root / "audit.jsonl"
        self.observations_path = root / "campaign_observations.jsonl"

    def _load_registry(self) -> dict[str, Any]:
        if not self.registry_path.exists():
            return {"revision": 0, "candidates": {}, "champion_id": None}
        return json.loads(self.registry_path.read_text(encoding="utf-8"))

    def _save_registry(self, registry: dict[str, Any]) -> None:
        registry["revision"] = int(registry.get("revision", 0)) + 1
        _atomic_json(self.registry_path, registry)

    def _audit(self, event: str, payload: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        record = {
            "event_id": _sha256(_canonical_json({
                "event": event,
                "payload": payload,
                "time_ns": time.time_ns(),
            })),
            "event": event,
            "recorded_at": time.time(),
            **payload,
        }
        with self.audit_path.open("ab") as handle:
            handle.write(_canonical_json(record) + b"\n")

    def put_artifact(self, content: bytes, metadata: dict[str, Any]) -> str:
        digest = _sha256(content)
        artifact_path = self.artifacts_dir / digest / "artifact.bin"
        manifest_path = artifact_path.with_name("manifest.json")
        manifest = {
            "sha256": digest,
            "size": len(content),
            "metadata": metadata,
        }
        if artifact_path.exists():
            if artifact_path.read_bytes() != content:
                raise RuntimeError("artifact digest collision")
            if json.loads(manifest_path.read_text(encoding="utf-8")) != manifest:
                raise ValueError("immutable artifact metadata cannot be changed")
            return digest
        artifact_path.parent.mkdir(parents=True, exist_ok=False)
        artifact_path.write_bytes(content)
        _atomic_json(manifest_path, manifest)
        return digest

    def register(self, spec: CandidateSpec) -> CandidateSpec:
        spec.validate()
        artifact_path = self.artifacts_dir / spec.artifact_sha256 / "artifact.bin"
        if not artifact_path.exists():
            raise ValueError("candidate artifact is not present in immutable store")
        registry = self._load_registry()
        existing = registry["candidates"].get(spec.candidate_id)
        serialized = _serialize_spec(spec)
        if existing:
            if existing != serialized:
                raise ValueError("candidate registrations are immutable")
            return _deserialize_spec(existing)
        registry["candidates"][spec.candidate_id] = serialized
        self._save_registry(registry)
        self._audit("candidate_registered", {"candidate_id": spec.candidate_id})
        return spec

    def put_evidence(self, evidence: dict[str, Any]) -> str:
        _verify_evidence_digest(evidence)
        digest = evidence["evidence_digest"]
        path = self.evidence_dir / f"{digest}.json"
        if path.exists():
            if json.loads(path.read_text(encoding="utf-8")) != evidence:
                raise ValueError("immutable evidence cannot be changed")
            return digest
        _atomic_json(path, evidence)
        self._audit("evidence_recorded", {
            "candidate_id": evidence["candidate_id"],
            "evidence_digest": digest,
        })
        return digest

    def get_evidence(self, digest: str) -> dict[str, Any]:
        path = self.evidence_dir / f"{digest}.json"
        if not path.exists():
            raise KeyError(digest)
        evidence = json.loads(path.read_text(encoding="utf-8"))
        _verify_evidence_digest(evidence)
        return evidence

    def append_observations(
        self,
        observations: Iterable[CampaignObservation],
    ) -> int:
        rows = list(observations)
        for row in rows:
            row.validate()
        self.root.mkdir(parents=True, exist_ok=True)
        existing_ids = {
            record["observation_id"]
            for record in self._observation_records()
        }
        appended = 0
        with self.observations_path.open("ab") as handle:
            for row in rows:
                payload = asdict(row)
                observation_id = _sha256(_canonical_json(payload))
                if observation_id in existing_ids:
                    continue
                handle.write(_canonical_json({
                    "observation_id": observation_id,
                    **payload,
                }) + b"\n")
                existing_ids.add(observation_id)
                appended += 1
        return appended

    def _observation_records(self) -> list[dict[str, Any]]:
        if not self.observations_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.observations_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def observations(
        self,
        candidate_id: str | None = None,
        limit: int | None = None,
    ) -> list[CampaignObservation]:
        records = self._observation_records()
        if candidate_id:
            records = [
                record for record in records
                if record["candidate_id"] == candidate_id
            ]
        if limit is not None:
            records = records[-limit:]
        return [
            CampaignObservation(**{
                key: value
                for key, value in record.items()
                if key != "observation_id"
            })
            for record in records
        ]

    def get(self, candidate_id: str) -> CandidateSpec:
        raw = self._load_registry()["candidates"].get(candidate_id)
        if not raw:
            raise KeyError(candidate_id)
        return _deserialize_spec(raw)

    def status(self) -> dict[str, Any]:
        return self._load_registry()

    def transition(
        self,
        candidate_id: str,
        new_state: str,
        reason: str,
        evidence_digest: str | None = None,
        actor: str = "governance",
    ) -> CandidateSpec:
        if new_state not in MODEL_STATES:
            raise ValueError(f"unsupported model state: {new_state}")
        if not reason.strip():
            raise ValueError("transition reason is required")
        registry = self._load_registry()
        raw = registry["candidates"].get(candidate_id)
        if not raw:
            raise KeyError(candidate_id)
        previous = raw["state"]
        raw["state"] = new_state
        if new_state == "champion":
            previous_champion = registry.get("champion_id")
            if previous_champion and previous_champion != candidate_id:
                registry["candidates"][previous_champion]["state"] = "retired"
            registry["champion_id"] = candidate_id
        elif registry.get("champion_id") == candidate_id:
            registry["champion_id"] = None
        self._save_registry(registry)
        self._audit("state_transition", {
            "candidate_id": candidate_id,
            "from_state": previous,
            "to_state": new_state,
            "reason": reason,
            "evidence_digest": evidence_digest,
            "actor": actor,
        })
        return _deserialize_spec(raw)

    def rollback(self, candidate_id: str, reason: str) -> CandidateSpec:
        candidate = self.get(candidate_id)
        if not candidate.parent_candidate_id:
            raise ValueError("candidate has no reversible parent")
        self.transition(candidate_id, "retired", reason, actor="rollback")
        return self.transition(
            candidate.parent_candidate_id,
            "champion",
            f"rollback from {candidate_id}: {reason}",
            actor="rollback",
        )


def _serialize_spec(spec: CandidateSpec) -> dict[str, Any]:
    value = asdict(spec)
    value["versions"] = asdict(spec.versions)
    return value


def _deserialize_spec(value: dict[str, Any]) -> CandidateSpec:
    return CandidateSpec(
        **{
            **value,
            "versions": VersionSet(**value["versions"]),
        }
    )


def chronological_partition(
    observations: Iterable[CampaignObservation],
    thresholds: GovernanceThresholds,
) -> dict[str, Any]:
    rows = sorted(observations, key=lambda row: (row.observed_at, row.campaign_id))
    campaigns: dict[str, list[CampaignObservation]] = {}
    for row in rows:
        row.validate()
        campaigns.setdefault(row.campaign_id, []).append(row)
    ordered_campaigns = sorted(
        campaigns,
        key=lambda campaign_id: min(row.observed_at for row in campaigns[campaign_id]),
    )
    final_count = max(1, math.ceil(len(ordered_campaigns) * thresholds.final_test_fraction))
    development_ids = ordered_campaigns[:-final_count]
    final_ids = ordered_campaigns[-final_count:]
    return {
        "campaigns": campaigns,
        "development_ids": development_ids,
        "final_ids": final_ids,
        "final_test_fingerprint": _sha256(_canonical_json(final_ids)),
    }


def purged_walk_forward_folds(
    observations: Iterable[CampaignObservation],
    thresholds: GovernanceThresholds,
) -> list[dict[str, Any]]:
    partition = chronological_partition(observations, thresholds)
    campaigns = partition["campaigns"]
    development_ids = partition["development_ids"]
    if len(development_ids) < 2:
        return []
    fold_count = min(thresholds.walk_forward_folds, len(development_ids) - 1)
    validation_size = max(1, len(development_ids) // (fold_count + 1))
    folds: list[dict[str, Any]] = []
    for fold_index in range(fold_count):
        validation_start_index = validation_size * (fold_index + 1)
        validation_ids = development_ids[
            validation_start_index:validation_start_index + validation_size
        ]
        if not validation_ids:
            continue
        validation_rows = [
            row for campaign_id in validation_ids for row in campaigns[campaign_id]
        ]
        validation_start = min(row.observed_at for row in validation_rows)
        purge_before = validation_start - thresholds.purge_gap_seconds
        train_ids = development_ids[:validation_start_index]
        train_rows = [
            row
            for campaign_id in train_ids
            for row in campaigns[campaign_id]
            if row.label_end_at < purge_before
        ]
        folds.append({
            "fold": fold_index + 1,
            "train_campaign_ids": sorted({row.campaign_id for row in train_rows}),
            "validation_campaign_ids": list(validation_ids),
            "train_rows": train_rows,
            "validation_rows": validation_rows,
            "purge_before": purge_before,
        })
    return folds


def _selected(rows: Iterable[CampaignObservation], selector: str) -> list[CampaignObservation]:
    return [row for row in rows if bool(getattr(row, selector))]


def _max_drawdown(rows: list[CampaignObservation]) -> float:
    equity = 0.0
    peak = 0.0
    maximum = 0.0
    for row in sorted(rows, key=lambda value: value.observed_at):
        equity += row.net_vst
        peak = max(peak, equity)
        maximum = max(maximum, peak - equity)
    return maximum


def _campaign_expectancies(rows: list[CampaignObservation]) -> list[float]:
    grouped: dict[str, list[float]] = {}
    for row in rows:
        grouped.setdefault(row.campaign_id, []).append(row.net_vst)
    return [sum(values) / len(values) for values in grouped.values()]


def _bootstrap_ci(
    values: list[float],
    thresholds: GovernanceThresholds,
    seed: int,
) -> dict[str, float]:
    if not values:
        return {"lower": 0.0, "upper": 0.0, "confidence": thresholds.confidence_level}
    if len(values) == 1:
        return {
            "lower": values[0],
            "upper": values[0],
            "confidence": thresholds.confidence_level,
        }
    rng = random.Random(seed)
    draws = []
    for _ in range(thresholds.bootstrap_samples):
        sample = [values[rng.randrange(len(values))] for _ in values]
        draws.append(sum(sample) / len(sample))
    draws.sort()
    alpha = (1.0 - thresholds.confidence_level) / 2.0
    lower_index = max(0, int(alpha * len(draws)))
    upper_index = min(len(draws) - 1, int((1.0 - alpha) * len(draws)) - 1)
    return {
        "lower": draws[lower_index],
        "upper": draws[upper_index],
        "confidence": thresholds.confidence_level,
    }


def _calibration(rows: list[CampaignObservation]) -> dict[str, float | None]:
    scored = [
        row for row in rows
        if row.predicted_probability is not None and row.outcome in {0, 1}
    ]
    if not scored:
        return {"brier": None, "error": None}
    brier = sum(
        (float(row.predicted_probability) - int(row.outcome)) ** 2 for row in scored
    ) / len(scored)
    error = abs(
        sum(float(row.predicted_probability) for row in scored) / len(scored)
        - sum(int(row.outcome) for row in scored) / len(scored)
    )
    return {"brier": brier, "error": error}


def _metrics(
    rows: list[CampaignObservation],
    selector: str,
    thresholds: GovernanceThresholds,
    seed: int,
) -> dict[str, Any]:
    accepted = _selected(rows, selector)
    campaign_values = _campaign_expectancies(accepted)
    return {
        "observations": len(rows),
        "accepted": len(accepted),
        "campaigns": len({row.campaign_id for row in accepted}),
        "symbols": sorted({row.symbol for row in accepted}),
        "sides": sorted({row.side for row in accepted}),
        "regimes": sorted({row.regime for row in accepted}),
        "net_vst": sum(row.net_vst for row in accepted),
        "expectancy_vst": (
            sum(row.net_vst for row in accepted) / len(accepted) if accepted else 0.0
        ),
        "expectancy_ci": _bootstrap_ci(campaign_values, thresholds, seed),
        "max_drawdown_vst": _max_drawdown(accepted),
        "operational_reliability": (
            sum(1 for row in rows if row.operational_ok) / len(rows) if rows else 0.0
        ),
        "calibration": _calibration(rows),
    }


def evaluate_candidate(
    candidate: CandidateSpec,
    observations: Iterable[CampaignObservation],
    thresholds: GovernanceThresholds | None = None,
) -> dict[str, Any]:
    thresholds = thresholds or GovernanceThresholds()
    rows = [row for row in observations if row.candidate_id == candidate.candidate_id]
    partition = chronological_partition(rows, thresholds)
    final_ids = set(partition["final_ids"])
    development_rows = [row for row in rows if row.campaign_id not in final_ids]
    folds = purged_walk_forward_folds(rows, thresholds)
    validation_rows = [
        row for fold in folds for row in fold["validation_rows"]
    ]
    candidate_metrics = _metrics(
        validation_rows, "candidate_accepted", thresholds, seed=11
    )
    baseline_metrics = _metrics(
        validation_rows, "baseline_accepted", thresholds, seed=17
    )
    champion_metrics = _metrics(
        validation_rows, "champion_accepted", thresholds, seed=23
    )
    calibration = candidate_metrics["calibration"]
    checks = {
        "artifact_frozen": candidate.frozen,
        "enough_campaigns": candidate_metrics["campaigns"] >= thresholds.min_campaigns,
        "multiple_symbols": len(candidate_metrics["symbols"]) >= thresholds.min_symbols,
        "both_sides": len(candidate_metrics["sides"]) >= thresholds.min_sides,
        "multiple_regimes": len(candidate_metrics["regimes"]) >= thresholds.min_regimes,
        "positive_oos_expectancy": (
            candidate_metrics["expectancy_ci"]["lower"] > thresholds.min_expectancy_vst
        ),
        "beats_baseline": (
            candidate_metrics["expectancy_ci"]["lower"]
            - baseline_metrics["expectancy_ci"]["upper"]
            > thresholds.min_uplift_vst
        ),
        "controlled_drawdown": (
            candidate_metrics["max_drawdown_vst"] <= thresholds.max_drawdown_vst
        ),
        "operationally_reliable": (
            candidate_metrics["operational_reliability"]
            >= thresholds.min_operational_reliability
        ),
        "calibrated": (
            calibration["brier"] is None
            or (
                calibration["brier"] <= thresholds.max_brier
                and calibration["error"] <= thresholds.max_calibration_error
            )
        ),
        "walk_forward_available": bool(folds),
        "final_test_untouched": True,
    }
    evidence = {
        "candidate_id": candidate.candidate_id,
        "kind": candidate.kind,
        "versions": asdict(candidate.versions),
        "artifact_sha256": candidate.artifact_sha256,
        "evaluation_scope": "purged_walk_forward_validation",
        "development_campaigns": len(set(
            row.campaign_id for row in development_rows
        )),
        "final_test": {
            "campaigns": len(final_ids),
            "fingerprint": partition["final_test_fingerprint"],
            "metrics_exposed": False,
        },
        "folds": [{
            "fold": fold["fold"],
            "train_campaigns": len(fold["train_campaign_ids"]),
            "validation_campaigns": len(fold["validation_campaign_ids"]),
            "train_rows_after_purge": len(fold["train_rows"]),
            "validation_rows": len(fold["validation_rows"]),
            "campaign_overlap": bool(
                set(fold["train_campaign_ids"])
                & set(fold["validation_campaign_ids"])
            ),
        } for fold in folds],
        "candidate": candidate_metrics,
        "baseline": baseline_metrics,
        "champion": champion_metrics,
        "checks": checks,
    }
    evidence["eligible_for_promotion"] = all(checks.values())
    evidence["evidence_digest"] = _sha256(_canonical_json(evidence))
    return evidence


def promote_candidate(
    store: GovernanceStore,
    candidate_id: str,
    evidence: dict[str, Any],
    actor: str = "governance",
) -> CandidateSpec:
    candidate = store.get(candidate_id)
    _verify_evidence_digest(evidence)
    if evidence.get("candidate_id") != candidate_id:
        raise ValueError("evidence does not belong to candidate")
    if evidence.get("artifact_sha256") != candidate.artifact_sha256:
        raise ValueError("evidence artifact does not match registered artifact")
    if not evidence.get("eligible_for_promotion"):
        raise ValueError("candidate does not satisfy promotion evidence")
    if evidence.get("final_test", {}).get("metrics_exposed"):
        raise ValueError("promotion evidence must not optimize against final test")
    return store.transition(
        candidate_id,
        "champion",
        "all promotion checks passed",
        evidence_digest=evidence["evidence_digest"],
        actor=actor,
    )


def _verify_evidence_digest(evidence: dict[str, Any]) -> None:
    claimed = str(evidence.get("evidence_digest") or "")
    unsigned = dict(evidence)
    unsigned.pop("evidence_digest", None)
    actual = _sha256(_canonical_json(unsigned))
    if claimed != actual:
        raise ValueError("evidence digest is invalid")


def monitor_and_demote(
    store: GovernanceStore,
    candidate_id: str,
    recent_observations: Iterable[CampaignObservation],
    thresholds: GovernanceThresholds | None = None,
) -> dict[str, Any]:
    thresholds = thresholds or GovernanceThresholds()
    candidate = store.get(candidate_id)
    rows = [row for row in recent_observations if row.candidate_id == candidate_id]
    metrics = _metrics(rows, "candidate_accepted", thresholds, seed=29)
    calibration = metrics["calibration"]
    reasons: list[str] = []
    enough_evidence = metrics["campaigns"] >= thresholds.monitoring_min_campaigns
    if enough_evidence and metrics["expectancy_ci"]["upper"] <= thresholds.min_expectancy_vst:
        reasons.append("expectancy_deteriorated")
    if enough_evidence and (
        metrics["operational_reliability"] < thresholds.min_operational_reliability
    ):
        reasons.append("operational_reliability_deteriorated")
    if enough_evidence and calibration["brier"] is not None and (
        calibration["brier"] > thresholds.max_brier
        or calibration["error"] > thresholds.max_calibration_error
    ):
        reasons.append("calibration_deteriorated")
    if enough_evidence and metrics["max_drawdown_vst"] > thresholds.max_drawdown_vst:
        reasons.append("drawdown_limit_exceeded")
    demoted = bool(reasons) and candidate.state in {"champion", "review"}
    if demoted:
        store.transition(
            candidate_id,
            "shadow",
            ",".join(reasons),
            actor="automatic_monitor",
        )
    return {
        "demoted": demoted,
        "enough_evidence": enough_evidence,
        "reasons": reasons,
        "metrics": metrics,
    }
