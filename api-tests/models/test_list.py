# /// script
# requires-python = ">=3.11"
# dependencies = ["openai==3.16.2", "pydantic>=2,<3", "typer>=0.16,<1", "rich>=14,<15"]
# ///
# Usage: OPENAI_API_KEY=... uv run api-tests/models/test_list.py --base-url http://localhost:8788/v1
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Annotated, ClassVar, Literal
from urllib.parse import urlsplit

import openai
import typer
from pydantic import BaseModel, ConfigDict, ValidationError
from rich.console import Console
from rich.table import Table
from rich.text import Text

console = Console()
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "results"


class Model(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(strict=True, frozen=True, extra="ignore")
    id: str
    object: Literal["model"]
    created: int
    owned_by: str


class ModelList(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(strict=True, frozen=True, extra="ignore")
    object: Literal["list"]
    data: list[Model]


class Check(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)
    name: str
    passed: bool
    detail: str


class Report(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)
    timestamp: str
    sdk_version: str
    request_method: str
    request_url: str
    request_headers: dict[str, str]
    request_body: None = None
    response_status: int | None
    response_content_type: str | None
    response_body: str | None
    duration_seconds: float
    checks: list[Check]
    exit_code: int


def main(
    base_url: Annotated[str, typer.Option(help="URL de base incluant /v1.")],
    key_file: Annotated[Path | None, typer.Option(help="Fichier contenant la clé ; sinon OPENAI_API_KEY.")] = None,
    output_dir: Annotated[Path, typer.Option(help="Dossier des rapports JSON.")] = DEFAULT_OUTPUT_DIR,
) -> None:
    """Teste uniquement GET /v1/models, sans génération ni nouvelle tentative."""
    url = urlsplit(base_url)
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise typer.BadParameter("URL HTTP(S) sans identifiants, paramètres ni fragment.")
    if url.path.rstrip("/") != "/v1":
        raise typer.BadParameter("L’URL de base doit se terminer par /v1.")
    try:
        api_key = key_file.read_text().strip() if key_file else os.environ.get("OPENAI_API_KEY", "").strip()
    except OSError as error:
        console.print(f"Clé inaccessible : {error.strerror}", markup=False)
        raise typer.Exit(2) from error
    if not api_key:
        raise typer.BadParameter("Définir OPENAI_API_KEY ou --key-file.")

    checks: list[Check] = []
    response_body: str | None = None
    response_status: int | None = None
    content_type: str | None = None
    request_url = base_url.rstrip("/") + "/models"
    request_headers: dict[str, str] = {}
    started = perf_counter()
    exit_code = 1
    with openai.OpenAI(
        api_key=api_key, base_url=base_url.rstrip("/") + "/", max_retries=0, timeout=30,
        http_client=openai.DefaultHttpxClient(follow_redirects=False),
    ) as client:
        try:
            raw = client.models.with_raw_response.list()
        except openai.APIStatusError as error:
            response = error.response
            checks.append(Check(name="SDK", passed=False, detail=f"HTTP {response.status_code}"))
        except openai.APIConnectionError as error:
            response = None
            request_url = str(error.request.url)
            request_headers = dict(error.request.headers)
            checks.append(Check(name="Connexion", passed=False, detail=type(error).__name__))
            exit_code = 2
        else:
            response = raw.http_response
            try:
                _ = raw.parse()
            except (openai.APIResponseValidationError, json.JSONDecodeError, ValidationError) as error:
                checks.append(Check(name="SDK", passed=False, detail=type(error).__name__))
            else:
                checks.append(Check(name="SDK", passed=True, detail="client.models.list() lisible"))
        if response is not None:
            request_url = str(response.request.url)
            request_headers = dict(response.request.headers)
            response_status = response.status_code
            content_type = response.headers.get("content-type", "")
            response_body = response.text
            checks.append(Check(name="HTTP", passed=response_status == 200, detail=f"Statut {response_status}, attendu 200"))
            checks.append(Check(name="Content-Type", passed=content_type.split(";")[0].strip().lower() == "application/json", detail=content_type))
            try:
                catalog = ModelList.model_validate_json(response_body)
            except ValidationError as error:
                details = "; ".join(f"{'.'.join(str(part) for part in item['loc']) or 'racine'}: {item['type']}" for item in error.errors(include_input=False, include_url=False))
                checks.append(Check(name="Contrat JSON", passed=False, detail=details))
            else:
                checks.append(Check(name="Contrat JSON", passed=True, detail=f"{len(catalog.data)} modèle(s), champs et types conformes"))
            exit_code = 0 if all(check.passed for check in checks) else 1

    timestamp = datetime.now(timezone.utc)
    safe_headers = {name: value if name.lower() in {"accept", "content-type", "user-agent", "host"} else "[REDACTED]" for name, value in request_headers.items()}
    report = Report(
        timestamp=timestamp.isoformat(), sdk_version=openai.__version__,
        request_method="GET", request_url=request_url, request_headers=safe_headers,
        response_status=response_status, response_content_type=content_type,
        response_body=response_body, duration_seconds=round(perf_counter() - started, 3),
        checks=checks, exit_code=exit_code,
    )
    # Also redact a key echoed by the server, including its JSON-escaped spelling.
    serialized = report.model_dump_json(indent=2).replace(json.dumps(api_key)[1:-1], "[REDACTED]").replace(api_key, "[REDACTED]")
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        report_path = output_dir / f"list-{timestamp.strftime('%Y%m%dT%H%M%S%fZ')}.json"
        with report_path.open("x") as output:
            _ = output.write(serialized + "\n")
    except OSError as error:
        console.print(f"Rapport non enregistré : {error.strerror}", markup=False)
        raise typer.Exit(2) from error
    console.print(f"GET {request_url}", markup=False)
    table = Table("Contrôle", "Verdict", "Détail")
    for check in checks:
        table.add_row(Text(check.name), Text("PASS" if check.passed else "FAIL", style="bold green" if check.passed else "bold red"), Text(check.detail.replace(api_key, "[REDACTED]")))
    console.print(table)
    passed = sum(check.passed for check in checks)
    console.print(Text(
        f"{passed}/{len(checks)} contrôles réussis · " + ("CONFORME" if exit_code == 0 else "ESSAI IMPOSSIBLE" if exit_code == 2 else "NON CONFORME"),
        style="bold green" if exit_code == 0 else "bold yellow" if exit_code == 2 else "bold red",
    ))
    console.print(f"Rapport : {report_path}", markup=False)
    raise typer.Exit(exit_code)


if __name__ == "__main__":
    typer.run(main)
