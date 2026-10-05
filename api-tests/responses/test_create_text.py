# /// script
# requires-python = ">=3.11"
# dependencies = ["openai==3.16.2", "pydantic>=2,<3", "typer>=0.16,<1", "rich>=14,<15"]
# ///
# Usage: uv run api-tests/responses/test_create_text.py --base-url http://localhost:8788/v1 --model MODEL
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
from openai.types.responses import Response
from pydantic import BaseModel, ConfigDict, ValidationError
from rich.console import Console
from rich.table import Table
from rich.text import Text

console = Console()
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "results"
PROMPT = "Réponds exactement : TEST_OK"


class Check(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)
    category: Literal["technique", "consigne"] = "technique"
    name: str
    passed: bool | None
    detail: str


class Report(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)
    timestamp: str
    sdk_version: str = openai.__version__
    scenario: str = "responses/create-text"
    request_method: str = "POST"
    request_url: str
    request_headers: dict[str, str]
    request_body: str
    response_status: int | None
    response_content_type: str | None
    response_body: str | None
    output_text: str | None
    duration_seconds: float
    checks: list[Check]
    technical_passed: bool
    behavior_passed: bool | None
    exit_code: int


def contract_checks(body: str, parsed: Response | None) -> tuple[list[Check], str | None]:
    try:
        response = Response.model_validate_json(body, strict=True)
    except ValidationError as error:
        detail = "; ".join(f"{'.'.join(map(str, item['loc']))}: {item['type']}" for item in error.errors(include_input=False, include_url=False))
        return [Check(name="Contrat JSON", passed=False, detail=detail)], None
    checks = [Check(name="Contrat JSON", passed=True, detail="Schéma officiel Responses, validation stricte")]
    checks.append(Check(name="État final", passed=response.status == "completed" and response.error is None and response.incomplete_details is None, detail=f"status={response.status}, error={response.error is not None}"))
    has_text = any(item.type == "message" and item.role == "assistant" and item.status == "completed" and any(content.type == "output_text" and bool(content.text.strip()) for content in item.content) for item in response.output)
    checks.append(Check(name="Message assistant", passed=has_text, detail="Message terminé contenant du texte"))
    usage = response.usage
    valid_usage = usage is not None and all(value >= 0 for value in (usage.input_tokens, usage.output_tokens, usage.total_tokens, usage.input_tokens_details.cached_tokens, usage.input_tokens_details.cache_write_tokens, usage.output_tokens_details.reasoning_tokens)) and usage.total_tokens == usage.input_tokens + usage.output_tokens and usage.input_tokens_details.cached_tokens <= usage.input_tokens and usage.output_tokens_details.reasoning_tokens <= usage.output_tokens
    checks.append(Check(name="Usage", passed=valid_usage, detail="Compteurs présents, non négatifs, total et détails cohérents"))
    text = parsed.output_text if parsed is not None else None
    return checks, text


def main(
    base_url: Annotated[str, typer.Option(help="URL du proxy incluant /v1.")],
    model: Annotated[str, typer.Option(help="Modèle à tester.")],
    key_file: Annotated[Path | None, typer.Option(help="Clé du proxy ; sinon OPENAI_API_KEY.")] = None,
    output_dir: Annotated[Path, typer.Option(help="Dossier des rapports.")] = DEFAULT_OUTPUT_DIR,
) -> None:
    """Responses 01 : créer une réponse texte, sans streaming ni stockage côté client."""
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
    started = perf_counter()
    checks: list[Check] = []
    body: str | None = None
    status: int | None = None
    content_type: str | None = None
    output_text: str | None = None
    parsed: Response | None = None
    unavailable = False
    with openai.OpenAI(api_key=key, base_url=base_url.rstrip("/") + "/", max_retries=0, timeout=300, http_client=openai.DefaultHttpxClient(follow_redirects=False)) as client:
        try:
            raw = client.responses.with_raw_response.create(model=model, input=PROMPT, stream=False, store=False)
        except openai.APIStatusError as error:
            http_response = error.response
            request = error.request
            checks.append(Check(name="SDK", passed=False, detail=f"HTTP {error.status_code}"))
        except openai.APIConnectionError as error:
            http_response = None
            request = error.request
            unavailable = True
            checks.append(Check(name="Connexion", passed=False, detail=type(error).__name__))
        else:
            http_response = raw.http_response
            request = http_response.request
            try:
                if http_response.headers.get("content-type", "").split(";")[0].strip().lower() == "application/json":
                    parsed = raw.parse()
            except (openai.APIResponseValidationError, json.JSONDecodeError, ValidationError) as error:
                checks.append(Check(name="SDK", passed=False, detail=type(error).__name__))
            else:
                checks.append(Check(name="SDK", passed=parsed is not None, detail="Réponse lue par le SDK officiel" if parsed is not None else "Le SDK ne retourne pas un objet Response"))
        if http_response is not None:
            status = http_response.status_code
            content_type = http_response.headers.get("content-type", "")
            body = http_response.text
            checks.append(Check(name="HTTP", passed=status == 200, detail=f"Statut {status}, attendu 200"))
            checks.append(Check(name="Content-Type", passed=content_type.split(";")[0].strip().lower() == "application/json", detail=content_type))
            contract, output_text = contract_checks(body, parsed)
            checks.extend(contract)
        request_url = str(request.url)
        headers = {name: value if name.lower() in {"accept", "content-type", "user-agent", "host"} else "[REDACTED]" for name, value in request.headers.items()}
        request_body = request.content.decode("utf-8")
    technical = all(check.passed is True for check in checks)
    behavior = output_text.strip() == "TEST_OK" if output_text is not None else None
    checks.append(Check(category="consigne", name="Texte attendu", passed=behavior, detail="TEST_OK après suppression des espaces extérieurs" if behavior is not None else "Non évalué : réponse inexploitable"))
    exit_code = 2 if unavailable else 0 if technical and behavior else 1
    timestamp = datetime.now(timezone.utc)
    report = Report(timestamp=timestamp.isoformat(), request_url=request_url, request_headers=headers, request_body=request_body, response_status=status, response_content_type=content_type, response_body=body, output_text=output_text, duration_seconds=round(perf_counter() - started, 3), checks=checks, technical_passed=technical, behavior_passed=behavior, exit_code=exit_code)
    serialized = report.model_dump_json(indent=2).replace(json.dumps(key)[1:-1], "[REDACTED]").replace(key, "[REDACTED]")
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"create-text-{timestamp.strftime('%Y%m%dT%H%M%S%fZ')}.json"
        with path.open("x") as target:
            _ = target.write(serialized + "\n")
    except OSError as error:
        console.print(f"Rapport non enregistré : {error.strerror}", markup=False)
        raise typer.Exit(2) from error
    console.print(f"Texte reçu : {output_text.replace(key, '[REDACTED]') if output_text is not None else '(indisponible)'}", markup=False)
    table = Table("Catégorie", "Contrôle", "Verdict", "Détail")
    for check in checks:
        label = "PASS" if check.passed else "SKIP" if check.passed is None else "FAIL"
        style = "bold green" if check.passed else "yellow" if check.passed is None else "bold red"
        table.add_row(Text(check.category), Text(check.name), Text(label, style=style), Text(check.detail.replace(key, "[REDACTED]")))
    console.print(table)
    console.print(Text(f"Technique : {'CONFORME' if technical else 'ÉCHEC'} · Consigne : {'RESPECTÉE' if behavior else 'NON ÉVALUÉE' if behavior is None else 'NON RESPECTÉE'}", style="bold green" if exit_code == 0 else "bold yellow" if unavailable else "bold red"))
    console.print(f"Rapport : {path}", markup=False)
    raise typer.Exit(exit_code)


if __name__ == "__main__":
    typer.run(main)
