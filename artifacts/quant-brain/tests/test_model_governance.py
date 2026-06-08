from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from core.model_governance import (
    CampaignObservation,
    CandidateSpec,
    GovernanceStore,
    GovernanceThresholds,
    VersionSet,
    evaluate_candidate,
    monitor_and_demote,
    promote_candidate,
    purged_walk_forward_folds,
)


def _candidate(
    store: GovernanceStore,
    candidate_id: str = "ml-v1",
    parent_candidate_id: str | None = None,
) -> CandidateSpec:
    digest = store.put_artifact(b"frozen-model", {"format": "test"})
    candidate = CandidateSpec(
        candidate_id=candidate_id,
        kind="ml_challenger",
        versions=VersionSet("features-v1", "labels-v1", "policy-v1"),
        artifact_sha256=digest,
        created_at=1.0,
        parent_candidate_id=parent_candidate_id,
    )
    return store.register(candidate)


def _rows(candidate_id: str, count: int = 50) -> list[CampaignObservation]:
    rows = []
    for index in range(count):
        observed_at = float(index * 1000)
        rows.append(CampaignObservation(
            candidate_id=candidate_id,
            campaign_id=f"campaign-{index:03d}",
            observed_at=observed_at,
            label_end_at=observed_at + 120,
            symbol=("ETH-USDT", "SOL-USDT", "XRP-USDT")[index % 3],
            side=("LONG", "SHORT")[index % 2],
            regime=("BULL", "BEAR")[index % 2],
            net_vst=1.0,
            candidate_accepted=True,
            baseline_accepted=True,
            champion_accepted=True,
            predicted_probability=0.8,
            outcome=1,
        ))
    return rows


def test_artifacts_and_candidate_registrations_are_immutable() -> None:
    with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
        store = GovernanceStore(Path(directory))
        candidate = _candidate(store)
        with pytest.raises(ValueError):
            store.put_artifact(b"frozen-model", {"format": "changed"})
        with pytest.raises(ValueError):
            store.register(CandidateSpec(
                **{
                    **candidate.__dict__,
                    "state": "review",
                }
            ))


def test_walk_forward_purges_overlapping_labels_and_campaigns() -> None:
    thresholds = GovernanceThresholds(
        walk_forward_folds=2,
        purge_gap_seconds=300,
        final_test_fraction=0.2,
    )
    rows = _rows("ml-v1", 20)
    first_validation_at = rows[6].observed_at
    rows[5] = CampaignObservation(
        **{
            **rows[5].__dict__,
            "label_end_at": first_validation_at - 100,
        }
    )
    folds = purged_walk_forward_folds(rows, thresholds)
    assert folds
    for fold in folds:
        assert not (
            set(fold["train_campaign_ids"])
            & set(fold["validation_campaign_ids"])
        )
        assert all(
            row.label_end_at < fold["purge_before"] for row in fold["train_rows"]
        )


def test_evaluation_keeps_final_test_hidden() -> None:
    with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
        store = GovernanceStore(Path(directory))
        candidate = _candidate(store)
        evidence = evaluate_candidate(
            candidate,
            _rows(candidate.candidate_id),
            GovernanceThresholds(
                min_campaigns=5,
                min_uplift_vst=-0.01,
                bootstrap_samples=100,
                max_calibration_error=0.25,
            ),
        )
        assert evidence["final_test"]["campaigns"] > 0
        assert evidence["final_test"]["metrics_exposed"] is False
        validation_campaigns = sum(
            fold["validation_campaigns"] for fold in evidence["folds"]
        )
        assert evidence["candidate"]["campaigns"] == validation_campaigns


def test_promotion_is_evidence_based_and_reversible() -> None:
    with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
        store = GovernanceStore(Path(directory))
        parent_digest = store.put_artifact(b"champion", {"format": "test"})
        parent = store.register(CandidateSpec(
            candidate_id="champion-v0",
            kind="current_champion",
            versions=VersionSet("features-v1", "labels-v1", "policy-v0"),
            artifact_sha256=parent_digest,
            created_at=0.0,
            state="champion",
        ))
        store.transition(parent.candidate_id, "champion", "initial champion")
        candidate = _candidate(
            store,
            parent_candidate_id=parent.candidate_id,
        )
        evidence = evaluate_candidate(
            candidate,
            _rows(candidate.candidate_id),
            GovernanceThresholds(
                min_campaigns=5,
                min_uplift_vst=-0.01,
                bootstrap_samples=100,
                max_calibration_error=0.25,
            ),
        )
        assert evidence["eligible_for_promotion"]
        promote_candidate(store, candidate.candidate_id, evidence)
        assert store.status()["champion_id"] == candidate.candidate_id
        restored = store.rollback(candidate.candidate_id, "operator rollback")
        assert restored.candidate_id == parent.candidate_id
        assert store.status()["champion_id"] == parent.candidate_id


def test_degraded_champion_returns_to_shadow() -> None:
    with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
        store = GovernanceStore(Path(directory))
        candidate = _candidate(store)
        store.transition(candidate.candidate_id, "champion", "test champion")
        degraded = [
            CampaignObservation(
                **{
                    **row.__dict__,
                    "net_vst": -1.0,
                    "operational_ok": False,
                    "predicted_probability": 0.95,
                    "outcome": 0,
                }
            )
            for row in _rows(candidate.candidate_id, 12)
        ]
        result = monitor_and_demote(
            store,
            candidate.candidate_id,
            degraded,
            GovernanceThresholds(bootstrap_samples=100),
        )
        assert result["demoted"] is True
        assert store.get(candidate.candidate_id).state == "shadow"
        assert "expectancy_deteriorated" in result["reasons"]
