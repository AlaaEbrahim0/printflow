"""Contract layer: schema discovery, the vendored fallback and rejection paths."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.contracts import (
    CONTRACT_SCHEMA_VERSION,
    WORKER_JOB_SCHEMA,
    WORKER_RESULT_SCHEMA,
    candidate_directories,
    describe_document,
    resolve_contracts_dir,
    validate_job,
    validate_result,
)
from app.errors import CODE_INVALID_JOB, CODE_RESULT_INVALID, JobContractError, ResultContractError
from tests.conftest import CONTRACTS_DIR, REPO_ROOT, job_document, version_path


def test_repo_contracts_are_discovered_from_the_package() -> None:
    resolved = resolve_contracts_dir()
    assert resolved == (REPO_ROOT / "contracts" / "jsonschema").resolve(strict=False)
    assert (resolved / WORKER_JOB_SCHEMA).is_file()


def test_configured_directory_wins(tmp_path: Path) -> None:
    custom = tmp_path / "schemas"
    custom.mkdir()
    for name in (WORKER_JOB_SCHEMA, WORKER_RESULT_SCHEMA):
        (custom / name).write_text((CONTRACTS_DIR / name).read_text(encoding="utf-8"))
    assert resolve_contracts_dir(custom) == custom.resolve(strict=False)


def test_candidate_list_ends_with_the_vendored_copy() -> None:
    candidates = candidate_directories()
    assert candidates[-1].name == "_contracts"
    assert all(candidate.is_absolute() for candidate in candidates)


@pytest.mark.parametrize("name", (WORKER_JOB_SCHEMA, WORKER_RESULT_SCHEMA))
def test_vendored_copy_matches_the_frozen_contract(name: str) -> None:
    """The container fallback may never drift from the repository contract."""

    repository = REPO_ROOT / "contracts" / "jsonschema" / name
    vendored = Path(__file__).resolve().parents[1] / "app" / "_contracts" / name
    assert vendored.read_bytes() == repository.read_bytes(), (
        f"{name} changed in contracts/ — re-copy it into app/_contracts"
    )


def test_vendored_copy_is_used_when_the_repo_is_absent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The container case: no contracts/ directory next to the package."""

    from app import contracts

    async_root = tmp_path / "site-packages" / "app"
    async_root.mkdir(parents=True)
    monkeypatch.setattr(contracts, "_PACKAGE_DIR", async_root)

    resolved = contracts.resolve_contracts_dir()

    assert resolved.name == "_contracts"
    assert (resolved / WORKER_JOB_SCHEMA).is_file()
    example = json.loads(
        (REPO_ROOT / "contracts" / "examples" / "worker-job-classify.json").read_text()
    )
    assert validate_job(example, resolved)["type"] == "classify"


def test_missing_configured_directory_falls_back(tmp_path: Path) -> None:
    """A wrong PRINTSHEET_CONTRACTS_DIR must not break the worker outright."""

    resolved = resolve_contracts_dir(tmp_path / "does-not-exist")
    assert (resolved / WORKER_JOB_SCHEMA).is_file()
    assert (resolved / WORKER_RESULT_SCHEMA).is_file()


def test_raises_when_no_copy_of_the_contracts_exists(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from app import contracts

    monkeypatch.setattr(contracts, "_has_worker_schemas", lambda directory: False)
    with pytest.raises(contracts.ContractsNotFoundError):
        contracts.resolve_contracts_dir(tmp_path)


def test_all_frozen_job_examples_still_validate(example_dir: Path) -> None:
    paths = sorted(example_dir.glob("worker-job-*.json"))
    assert paths, "the frozen contract examples must exist"
    for path in paths:
        document = json.loads(path.read_text(encoding="utf-8"))
        problems = describe_document(WORKER_JOB_SCHEMA, document, CONTRACTS_DIR)
        assert problems == [], f"{path.name}: {problems}"


def test_all_frozen_result_examples_still_validate(example_dir: Path) -> None:
    for path in sorted(example_dir.glob("worker-result-*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        problems = describe_document(WORKER_RESULT_SCHEMA, document, CONTRACTS_DIR)
        assert problems == [], f"{path.name}: {problems}"


def test_missing_required_field_is_a_structured_failure() -> None:
    document = job_document("classify", version_path("a"))
    del document["designId"]

    with pytest.raises(JobContractError) as excinfo:
        validate_job(document, CONTRACTS_DIR)

    assert excinfo.value.code == CODE_INVALID_JOB
    assert excinfo.value.retryable is False
    assert excinfo.value.details["errors"]


def test_unknown_job_type_is_rejected() -> None:
    document = job_document("classify", version_path("a"))
    document["type"] = "shrink"
    with pytest.raises(JobContractError):
        validate_job(document, CONTRACTS_DIR)


def test_background_replacement_must_export_a_mask() -> None:
    document = job_document(
        "background-removal",
        version_path("a"),
        output_relative=version_path("b"),
        parameters={"mode": "none"},
    )
    with pytest.raises(JobContractError) as excinfo:
        validate_job(document, CONTRACTS_DIR)
    assert any("outputArtifacts" in problem for problem in excinfo.value.details["errors"])


def test_brush_ops_need_a_mask_source_version_to_carry_a_mask() -> None:
    document = job_document(
        "background-removal",
        version_path("a"),
        output_relative=version_path("b"),
        parameters={
            "mode": "color-to-alpha",
            "keyColor": "#FFFFFF",
            "maskFromVersionId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            "brushOps": [{"tool": "erase", "radiusPx": 4, "points": [[1, 1]]}],
        },
        output_artifacts={"mask": version_path("b").replace(".png", "/mask.png")},
    )
    with pytest.raises(JobContractError):
        validate_job(document, CONTRACTS_DIR)

    document["inputArtifacts"] = {"mask": version_path("a").replace(".png", "/mask.png")}
    assert validate_job(document, CONTRACTS_DIR)


def test_manual_trim_requires_a_crop_rect() -> None:
    document = job_document(
        "trim", version_path("a"), output_relative=version_path("b"), parameters={"mode": "manual"}
    )
    with pytest.raises(JobContractError):
        validate_job(document, CONTRACTS_DIR)


def test_classify_job_may_omit_output_path() -> None:
    document = job_document("classify", version_path("a"))
    assert "outputPath" not in document
    validate_job(document, CONTRACTS_DIR)


def test_result_without_output_or_suggestions_is_rejected() -> None:
    document = {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "jobId": "11111111-1111-4111-8111-111111111111",
        "status": "succeeded",
        "metadata": {"durationMs": 5},
    }
    with pytest.raises(ResultContractError) as excinfo:
        validate_result(document, CONTRACTS_DIR)
    assert excinfo.value.code == CODE_RESULT_INVALID


def test_failed_result_must_carry_an_error() -> None:
    document = {
        "schemaVersion": "1.0",
        "jobId": "11111111-1111-4111-8111-111111111111",
        "status": "failed",
        "metadata": {"durationMs": 5},
    }
    with pytest.raises(ResultContractError):
        validate_result(document, CONTRACTS_DIR)
