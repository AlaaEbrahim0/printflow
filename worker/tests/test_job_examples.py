"""Every frozen worker-job example is executed, not just schema-checked."""

from __future__ import annotations

import json

import pytest
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.errors import CODE_ENGINE_UNAVAILABLE, CODE_UNSUPPORTED_PARAMETERS
from app.pipeline import process_document
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    FakeCommandRunner,
    make_engines,
    make_settings,
)

EXPECTED = {
    "worker-job-classify.json": "succeeded",
    "worker-job-trim.json": "succeeded",
    "worker-job-background-removal.json": "unsupported-parameters",
    "worker-job-resize.json": "succeeded",
    # These two need external binaries that are deliberately not installed.
    "worker-job-upscale.json": "engine-unavailable",
    "worker-job-vectorize.json": "unsupported-parameters",
}

SIZE = (240, 160)


@pytest.fixture
def seeded(tmp_path):
    """Storage primed with synthetic images at exactly the example paths."""

    settings = make_settings(tmp_path)
    storage = StorageRoot(settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)

    def prime(document: dict) -> None:
        paths = [document["inputPath"]]
        for artifact in (document.get("inputArtifacts") or {}).values():
            paths.append(artifact)
        for relative in paths:
            absolute = storage.resolve(relative)
            absolute.parent.mkdir(parents=True, exist_ok=True)
            mode = "L" if relative.endswith("/mask.png") else "RGB"
            colour = 200 if mode == "L" else (190, 190, 190)
            image = Image.new(mode, SIZE, colour)
            if mode == "RGB":
                image.paste(Image.new("RGB", (80, 60), (20, 20, 20)), (60, 40))
            image.save(absolute)

    return settings, storage, prime


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_frozen_example_produces_a_valid_envelope(seeded, name: str, example_dir) -> None:
    settings, storage, prime = seeded
    document = json.loads((example_dir / name).read_text(encoding="utf-8"))
    prime(document)
    engines = make_engines(settings, FakeCommandRunner())

    processed = process_document(document, settings, storage=storage, engines=engines)

    assert describe_document(WORKER_RESULT_SCHEMA, processed.result, CONTRACTS_DIR) == []
    expectation = EXPECTED[name]
    if expectation == "succeeded":
        assert processed.succeeded, processed.result.get("error")
        assert processed.result["jobId"] == document["jobId"]
        if document["type"] != "classify":
            assert storage.resolve(processed.result["outputPath"]).is_file()
            assert processed.result["metadata"]["durationMs"] >= 0
        if document["type"] == "classify":
            features = processed.result["suggestions"]["features"]
            assert set(features["sampledBackground"]) <= {"kind", "hex", "confidence"}
    else:
        assert processed.succeeded is False
        expected_code = (
            CODE_UNSUPPORTED_PARAMETERS
            if expectation == "unsupported-parameters"
            else CODE_ENGINE_UNAVAILABLE
        )
        assert processed.result["error"]["code"] == expected_code
        assert processed.result["error"]["retryable"] is False
        if expectation == "unsupported-parameters":
            assert document["type"] in processed.result["error"]["details"]["retired"]


def test_examples_cover_every_frozen_job_type(example_dir) -> None:
    names = sorted(path.name for path in example_dir.glob("worker-job-*.json"))
    assert names == sorted(EXPECTED), "a new job type needs a processor and an example here"


def test_contract_dir_is_the_repository_one() -> None:
    assert CONTRACTS_DIR.is_dir()
