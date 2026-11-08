from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_health_reports_capabilities_and_storage(tmp_path: Path) -> None:
    settings = Settings(
        storage_root=tmp_path / "storage",
        worker_id="test-worker",
        gpu_enabled=False,
    )
    app = create_app(settings)

    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["workerId"] == "test-worker"
    assert body["storageWritable"] is True
    assert body["capabilities"] == ["image"]
    assert (tmp_path / "storage").is_dir()


def test_gpu_capability_tracks_gpu_setting() -> None:
    assert Settings(gpu_enabled=False).capability_list == ["image"]
    assert Settings(gpu_enabled=True).capability_list == ["image", "gpu"]
    assert Settings(gpu_enabled=True, capabilities="gpu").capability_list == ["gpu"]


def test_gpu_jobs_are_forced_to_one() -> None:
    settings = Settings(max_gpu_jobs=1)
    assert settings.max_gpu_jobs == 1
