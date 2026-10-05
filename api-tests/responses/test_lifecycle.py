#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["openai==3.16.2", "pydantic>=2,<3", "typer>=0.16,<1", "rich>=14,<15", "httpx2>=0.3"]
# ///
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Annotated, Literal
from urllib.parse import urlsplit

import openai
import typer
from pydantic import BaseModel, ConfigDict
from rich.console import Console

sys.path.insert(0, str(Path(__file__).parent))
from lifecycle_capture import CaptureReport, CaptureSession
from lifecycle_scenarios import Scenario, ScenarioExecution, execute

console = Console()
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "results"


class ReportOperation(BaseModel):
    model_config = ConfigDict(frozen=True)
    name: str
    functional_passed: bool | None
    capture: CaptureReport


class LifecycleReport(BaseModel):
    model_config = ConfigDict(frozen=True)
    timestamp: str
    scenario: Scenario
    sdk_version: str
    model: str
    base_url: str
    duration_seconds: float
    operations: tuple[ReportOperation, ...]
    resource_ids: tuple[str, ...]
    technical_passed: bool
    functional_passed: bool | None
    verdict: Literal["passed", "rejected", "unavailable"]
    exit_code: int


def _valid_base_url(value: str) -> str:
    parsed = urlsplit(value)
    valid = parsed.scheme in {"http", "https"} and parsed.hostname is not None and parsed.username is None and parsed.password is None and not parsed.query and not parsed.fragment and parsed.path.rstrip("/") == "/v1"
    if not valid:
        raise typer.BadParameter("URL HTTP(S) terminée par /v1, sans identifiants, paramètres ni fragment.")
    return value.rstrip("/")


def _verdict(execution: ScenarioExecution) -> tuple[Literal["passed", "rejected", "unavailable"], int, bool]:
    technical = all(operation.report.technical_passed for operation in execution.operations)
    functional = execution.functional_passed
    if functional is True:
        return "passed", 0, technical
    if any(operation.report.technical_passed for operation in execution.operations):
        return "rejected", 1, technical
    return "unavailable", 2, technical


def _write_report(execution: ScenarioExecution, scenario: Scenario, base_url: str, model: str, started: float, output_dir: Path) -> tuple[Path, LifecycleReport]:
    verdict, exit_code, technical = _verdict(execution)
    timestamp = datetime.now(timezone.utc)
    report = LifecycleReport(timestamp=timestamp.isoformat(), scenario=scenario, sdk_version=openai.__version__, model=model, base_url=base_url, duration_seconds=round(max(0.0, perf_counter() - started), 6), operations=tuple(ReportOperation(name=item.name, functional_passed=item.functional_passed, capture=item.report) for item in execution.operations), resource_ids=execution.resource_ids, technical_passed=technical, functional_passed=execution.functional_passed, verdict=verdict, exit_code=exit_code)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"lifecycle-{scenario}-{timestamp.strftime('%Y%m%dT%H%M%S%fZ')}.json"
    path.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return path, report


def main(
    scenario: Annotated[Scenario, typer.Option(help="previous-response, conversation, retrieve, delete, background-cancel, input-tokens, compact, or store-json.")],
    base_url: Annotated[str, typer.Option(help="URL du serveur incluant /v1.")],
    model: Annotated[str, typer.Option(help="Modèle à tester.")],
    key_file: Annotated[Path | None, typer.Option(help="Clé du serveur ; sinon OPENAI_API_KEY.")] = None,
    output_dir: Annotated[Path, typer.Option(help="Dossier des rapports.")] = DEFAULT_OUTPUT_DIR,
) -> None:
    normalized_url = _valid_base_url(base_url)
    key = key_file.read_text(encoding="utf-8").strip() if key_file is not None else os.environ.get("OPENAI_API_KEY", "").strip()
    if not key or not model.strip():
        raise typer.BadParameter("Définir OPENAI_API_KEY ou --key-file, et fournir --model.")
    started = perf_counter()
    with CaptureSession(base_url=normalized_url + "/", api_key=key) as session:
        execution = execute(session, scenario, model)
    path, report = _write_report(execution, scenario, normalized_url, model, started, output_dir)
    console.print(f"{scenario}: {report.verdict} ({report.duration_seconds:.3f}s); report: {path}", markup=False)
    raise typer.Exit(report.exit_code)


if __name__ == "__main__":
    typer.run(main)
