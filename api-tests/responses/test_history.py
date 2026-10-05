# /// script
# requires-python = ">=3.11"
# dependencies = ["openai==3.16.2", "pydantic>=2,<3", "typer>=0.16,<1", "rich>=14,<15"]
# ///
# Usage: uv run api-tests/responses/test_history.py --base-url http://localhost:8788/v1 --model MODEL
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from secrets import token_hex
from time import perf_counter
from typing import Annotated, ClassVar
from urllib.parse import urlsplit

import openai
import typer
from openai.types.responses import Response, ResponseInputParam
from pydantic import BaseModel, ConfigDict, ValidationError
from rich.console import Console
from rich.table import Table
from rich.text import Text
from test_create_text import Check, Report, contract_checks

console = Console()
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "results"


@dataclass(frozen=True, slots=True)
class TurnRequest:
    model: str
    messages: ResponseInputParam
    expected: str


class HistoryReport(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)
    timestamp: str
    sdk_version: str = openai.__version__
    scenario: str = "responses/history"
    context_code: str
    turns: list[Report]
    second_turn_skipped_reason: str | None
    technical_passed: bool | None
    behavior_passed: bool | None
    exit_code: int


def run_turn(client: openai.OpenAI, turn: TurnRequest) -> Report:
    started = perf_counter()
    checks: list[Check] = []
    parsed: Response | None = None
    text: str | None = None
    unavailable = False
    try:
        raw = client.responses.with_raw_response.create(model=turn.model, input=turn.messages, stream=False, store=False)
    except openai.APIStatusError as error:
        response, request = error.response, error.request
        checks.append(Check(name="SDK", passed=False, detail=f"HTTP {error.status_code}"))
    except openai.APIConnectionError as error:
        response, request = None, error.request
        unavailable = True
        checks.append(Check(name="Connexion", passed=False, detail=type(error).__name__))
    else:
        response, request = raw.http_response, raw.http_response.request
        try:
            if response.headers.get("content-type", "").split(";")[0].strip().lower() == "application/json":
                parsed = raw.parse()
        except (openai.APIResponseValidationError, json.JSONDecodeError, ValidationError) as error:
            checks.append(Check(name="SDK", passed=False, detail=type(error).__name__))
        else:
            checks.append(Check(name="SDK", passed=parsed is not None, detail="Lecture avec le SDK officiel"))
    body = response.text if response is not None else None
    content_type = response.headers.get("content-type", "") if response is not None else None
    if response is not None and body is not None:
        checks.append(Check(name="HTTP", passed=response.status_code == 200, detail=f"Statut {response.status_code}"))
        checks.append(Check(name="Content-Type", passed=content_type is not None and content_type.split(";")[0].strip().lower() == "application/json", detail=content_type or "Absent"))
        contract, text = contract_checks(body, parsed)
        checks.extend(contract)
    technical = all(check.passed is True for check in checks)
    behavior = text.strip() == turn.expected if text is not None else None
    checks.append(Check(category="consigne", name="Texte attendu", passed=behavior, detail=turn.expected if behavior is not None else "Non évalué"))
    headers = {name: value if name.lower() in {"accept", "content-type", "user-agent", "host"} else "[REDACTED]" for name, value in request.headers.items()}
    return Report(timestamp=datetime.now(timezone.utc).isoformat(), scenario="responses/history", request_url=str(request.url), request_headers=headers, request_body=request.content.decode("utf-8"), response_status=response.status_code if response is not None else None, response_content_type=content_type, response_body=body, output_text=text, duration_seconds=round(perf_counter() - started, 3), checks=checks, technical_passed=technical, behavior_passed=behavior, exit_code=2 if unavailable else 0 if technical and behavior else 1)


def main(
    base_url: Annotated[str, typer.Option(help="URL du proxy incluant /v1.")],
    model: Annotated[str, typer.Option(help="Modèle à tester.")],
    key_file: Annotated[Path | None, typer.Option(help="Clé du proxy ; sinon OPENAI_API_KEY.")] = None,
    output_dir: Annotated[Path, typer.Option(help="Dossier des rapports.")] = DEFAULT_OUTPUT_DIR,
) -> None:
    """Responses 03 : deux tours avec historique explicite, sans stockage ni previous_response_id."""
    url = urlsplit(base_url)
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment or url.path.rstrip("/") != "/v1":
        raise typer.BadParameter("URL HTTP(S) terminée par /v1, sans identifiants, paramètres ni fragment.")
    if not model.strip():
        raise typer.BadParameter("Le modèle ne peut pas être vide.")
    try:
        key = key_file.read_text().strip() if key_file else os.environ.get("OPENAI_API_KEY", "").strip()
    except OSError as error:
        console.print(f"Clé inaccessible : {error.strerror}", markup=False)
        raise typer.Exit(2) from error
    if not key:
        raise typer.BadParameter("Définir OPENAI_API_KEY ou --key-file.")
    code = f"CONTEXT_{token_hex(4)}"
    first_message = f"Le code de cette conversation est {code}. Réponds exactement : ACK"
    messages: ResponseInputParam = [{"role": "user", "content": first_message}]
    timestamp = datetime.now(timezone.utc)
    path = output_dir / f"history-{timestamp.strftime('%Y%m%dT%H%M%S%fZ')}.json"
    turns: list[Report] = []

    def save(skipped: str | None) -> HistoryReport:
        technical = False if any(not turn.technical_passed for turn in turns) else True if len(turns) == 2 else None
        behavior = False if any(turn.behavior_passed is False for turn in turns) else True if len(turns) == 2 and all(turn.behavior_passed is True for turn in turns) else None
        exit_code = 2 if any(turn.exit_code == 2 for turn in turns) else 0 if technical and behavior else 1
        report = HistoryReport(timestamp=timestamp.isoformat(), context_code=code, turns=turns, second_turn_skipped_reason=skipped, technical_passed=technical, behavior_passed=behavior, exit_code=exit_code)
        serialized = report.model_dump_json(indent=2).replace(json.dumps(key)[1:-1], "[REDACTED]").replace(key, "[REDACTED]")
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
            _ = path.write_text(serialized + "\n")
        except OSError as error:
            console.print(f"Rapport non enregistré : {error.strerror}", markup=False)
            raise typer.Exit(2) from error
        return report

    with openai.OpenAI(api_key=key, base_url=base_url.rstrip("/") + "/", max_retries=0, timeout=300, http_client=openai.DefaultHttpxClient(follow_redirects=False)) as client:
        console.print("Tour 1/2 : transmission du code…", markup=False)
        first = run_turn(client, TurnRequest(model, messages, "ACK"))
        turns.append(first)
        console.print(f"Réponse 1 : {(first.output_text or '(indisponible)').replace(key, '[REDACTED]')}", markup=False)
        report = save("En attente du second tour" if first.exit_code == 0 else "Premier tour non conforme ou consigne non respectée")
        if first.exit_code == 0 and first.output_text is not None:
            messages.extend([{"role": "assistant", "content": first.output_text}, {"role": "user", "content": "Quel est le code de cette conversation ? Réponds uniquement avec le code, sans autre texte."}])
            console.print("Tour 2/2 : rappel du code avec l’historique renvoyé…", markup=False)
            second = run_turn(client, TurnRequest(model, messages, code))
            turns.append(second)
            console.print(f"Réponse 2 : {(second.output_text or '(indisponible)').replace(key, '[REDACTED]')}", markup=False)
            report = save(None)
    table = Table("Tour", "Catégorie", "Contrôle", "Verdict", "Détail")
    for index, turn in enumerate(turns, 1):
        for check in turn.checks:
            label = "PASS" if check.passed else "SKIP" if check.passed is None else "FAIL"
            style = "bold green" if check.passed else "yellow" if check.passed is None else "bold red"
            table.add_row(str(index), check.category, Text(check.name), Text(label, style=style), Text(check.detail.replace(key, "[REDACTED]")))
    if report.second_turn_skipped_reason:
        table.add_row("2", "scénario", "Exécution", Text("SKIP", style="yellow"), Text(report.second_turn_skipped_reason))
    console.print(table)
    console.print(Text(f"Technique : {'CONFORME' if report.technical_passed else 'INCOMPLET' if report.technical_passed is None else 'ÉCHEC'} · Contexte : {'RETROUVÉ' if report.behavior_passed else 'NON ÉVALUÉ' if report.behavior_passed is None else 'ÉCHEC'}", style="bold green" if report.exit_code == 0 else "bold red"))
    console.print(f"Rapport : {path}", markup=False)
    raise typer.Exit(report.exit_code)


if __name__ == "__main__":
    typer.run(main)
