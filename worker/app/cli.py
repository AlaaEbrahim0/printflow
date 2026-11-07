"""``python -m app.cli`` — the file-only entry point this track is verified with.

``process`` is the important one: it validates a job document against the frozen
schema, runs the matching processor against a storage root on disk, validates
the emitted result, writes it out and exits non-zero on failure. No API, no
queue, no server.

    python -m app.cli process --job job.json --storage-root ../storage --result result.json
    python -m app.cli run --once
    python -m app.cli run --loop
    python -m app.cli classify ../storage/batch/design.png --storage-root ../storage

Exit codes: ``0`` succeeded, ``2`` the job ran and failed (the result envelope
carries the reason), ``1`` usage or I/O error.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any, TextIO

from app import __version__
from app.config import Settings
from app.contracts import resolve_contracts_dir, validate_job
from app.errors import WorkerError
from app.job_client import JobClient
from app.logs import setup_logging
from app.pipeline import process_document
from app.runner import JobRunner, install_signal_handlers
from app.storage import StorageRoot

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_JOB_FAILED = 2


def _load_json_document(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(stream: TextIO, document: Any, *, indent: int | None = 2) -> None:
    json.dump(document, stream, indent=indent, sort_keys=False)
    stream.write("\n")


def _settings_from_args(args: argparse.Namespace) -> Settings:
    updates: dict[str, Any] = {}
    if getattr(args, "storage_root", None):
        updates["storage_root"] = Path(args.storage_root)
    if getattr(args, "api_base_url", None):
        updates["api_base_url"] = args.api_base_url
    if getattr(args, "contracts_dir", None):
        updates["contracts_dir"] = Path(args.contracts_dir)
    if getattr(args, "gpu", None) is not None:
        updates["gpu_enabled"] = bool(args.gpu)
    return Settings(**updates)


def _classify_job(
    image_relative: str, settings: Settings, args: argparse.Namespace
) -> dict[str, Any]:
    """Build a schema-valid classify job for an ad-hoc run."""

    return {
        "schemaVersion": "1.0",
        "jobId": str(uuid.uuid4()),
        "type": "classify",
        "batchId": args.batch_id or str(uuid.uuid4()),
        "designId": args.design_id or str(uuid.uuid4()),
        "inputPath": image_relative,
        "parameters": {},
        "context": {"workingDpi": args.dpi or settings.working_dpi},
    }


def command_process(args: argparse.Namespace) -> int:
    settings = _settings_from_args(args)
    logger = setup_logging(settings)
    try:
        document = _load_json_document(args.job)
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("could not read job file %s: %s", args.job, exc)
        return EXIT_USAGE

    if not isinstance(document, Mapping):
        logger.error("job file %s must contain a JSON object", args.job)
        return EXIT_USAGE

    storage = StorageRoot(settings.storage_root)
    contracts_dir = resolve_contracts_dir(settings.contracts_dir)

    if args.validate_only:
        try:
            validate_job(document, contracts_dir)
        except WorkerError as error:
            print(f"INVALID: {error.message}", file=sys.stderr)
            for problem in error.details.get("errors", []):
                print(f"  - {problem}", file=sys.stderr)
            return EXIT_JOB_FAILED
        print(f"VALID: {args.job} satisfies worker-job.schema.json", file=sys.stderr)
        return EXIT_OK

    processed = process_document(document, settings, storage=storage, contracts_dir=contracts_dir)

    payload = json.dumps(processed.result, indent=2)
    if args.result:
        args.result.parent.mkdir(parents=True, exist_ok=True)
        args.result.write_text(payload + "\n", encoding="utf-8")
        print(f"result written to {args.result}", file=sys.stderr)
    if not args.quiet:
        _write_json(sys.stdout, processed.result)

    if args.validate_only:
        return EXIT_OK
    return EXIT_OK if processed.succeeded else EXIT_JOB_FAILED


def command_classify(args: argparse.Namespace) -> int:
    settings = _settings_from_args(args)
    setup_logging(settings)
    storage = StorageRoot(settings.storage_root)
    image = args.image.resolve(strict=False)
    try:
        image_relative = image.relative_to(storage.resolved_root).as_posix()
    except ValueError:
        print(
            f"classify: {args.image} is not inside the storage root "
            f"{storage.resolved_root}; pass --storage-root so the job can reference "
            "the file by relative path.",
            file=sys.stderr,
        )
        return EXIT_USAGE

    document = _classify_job(image_relative, settings, args)
    processed = process_document(document, settings, storage=storage)
    _write_json(sys.stdout, processed.result)
    return EXIT_OK if processed.succeeded else EXIT_JOB_FAILED


async def _run_client(args: argparse.Namespace, settings: Settings, *, once: bool) -> int:
    client = JobClient(
        base_url=settings.api_base_url,
        worker_key=settings.worker_key.get_secret_value(),
        worker_id=settings.worker_id,
        capabilities=settings.capability_list,
        lease_seconds=settings.lease_seconds,
        timeout_seconds=settings.api_timeout_seconds,
    )
    runner = JobRunner(settings=settings, client=client, storage=StorageRoot(settings.storage_root))
    stop_event = asyncio.Event()
    await install_signal_handlers(stop_event)
    try:
        if once:
            report = await runner.run_once(stop_event)
            summary = {"outcome": report.outcome, "jobId": report.job_id, "code": report.code}
            print(json.dumps(summary))
            return EXIT_OK if report.outcome in ("idle", "succeeded") else EXIT_JOB_FAILED
        await runner.run_loop(stop_event)
        return EXIT_OK
    finally:
        await client.aclose()


def command_run(args: argparse.Namespace) -> int:
    settings = _settings_from_args(args)
    setup_logging(settings)
    if not args.once and not args.loop:
        print("run: choose --once or --loop", file=sys.stderr)
        return EXIT_USAGE
    if args.once and args.loop:
        print("run: --once and --loop are mutually exclusive", file=sys.stderr)
        return EXIT_USAGE
    try:
        return asyncio.run(_run_client(args, settings, once=args.once))
    except KeyboardInterrupt:  # pragma: no cover - interactive convenience
        return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli",
        description="PrintSheet worker command line (file-based, no API required)",
    )
    parser.add_argument("--version", action="version", version=f"printsheet-worker {__version__}")
    parser.add_argument("--storage-root", type=Path, help="override PRINTSHEET_STORAGE_ROOT")
    parser.add_argument("--contracts-dir", type=Path, help="directory holding the frozen schemas")
    subparsers = parser.add_subparsers(dest="command", required=True)

    process = subparsers.add_parser("process", help="run one job document from a file")
    process.add_argument("--job", type=Path, required=True, help="worker-job JSON document")
    process.add_argument("--result", type=Path, help="write the result envelope here")
    process.add_argument("--api-base-url", help="only used by run")
    process.add_argument("--gpu", action="store_true", default=None, help="enable GPU engines")
    process.add_argument("--quiet", action="store_true", help="do not echo the result to stdout")
    process.add_argument(
        "--validate-only",
        action="store_true",
        help="validate the job document and exit (no processing)",
    )
    process.set_defaults(handler=command_process)

    run = subparsers.add_parser("run", help="claim jobs from the internal API")
    run.add_argument("--once", action="store_true", help="claim at most one job")
    run.add_argument("--loop", action="store_true", help="poll until SIGTERM/SIGINT")
    run.add_argument("--api-base-url", help="override PRINTSHEET_API_BASE_URL")
    run.add_argument("--gpu", action="store_true", default=None, help="enable GPU engines")
    run.set_defaults(handler=command_run)

    classify = subparsers.add_parser("classify", help="ad-hoc classification of one image")
    classify.add_argument("image", type=Path, help="image file inside the storage root")
    classify.add_argument("--dpi", type=int, help="working DPI for the synthetic job")
    classify.add_argument("--batch-id", help="synthetic batchId (default: random uuid)")
    classify.add_argument("--design-id", help="synthetic designId (default: random uuid)")
    classify.set_defaults(handler=command_classify)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = getattr(args, "handler", None)
    if handler is None:  # pragma: no cover - argparse requires a subcommand
        parser.print_help(sys.stderr)
        return EXIT_USAGE
    return int(handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
