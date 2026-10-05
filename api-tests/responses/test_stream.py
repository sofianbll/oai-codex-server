# /// script
# requires-python = ">=3.11"
# dependencies = ["openai==3.16.2", "pydantic>=2,<3", "typer>=0.16,<1", "rich>=14,<15"]
# ///
# Usage: uv run api-tests/responses/test_stream.py --base-url http://localhost:8788/v1 --model MODEL
from __future__ import annotations

import json
import os
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Annotated
from urllib.parse import urlsplit

import httpx2
import openai
import typer
from pydantic import BaseModel, ValidationError
from rich.console import Console
from rich.table import Table
from rich.text import Text
from stream_checks import evaluate_stream
from test_create_text import PROMPT, Check, Report
from typing_extensions import override

console = Console()
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "results"


class ObservedEvent(BaseModel):
    type: str
    elapsed_seconds: float


class StreamReport(Report):
    events: list[ObservedEvent]
    first_delta_seconds: float | None
    completed_seconds: float | None


class CapturedStream(httpx2.SyncByteStream):
    def __init__(self, source: httpx2.SyncByteStream, chunks: list[bytes]) -> None:
        self.source: httpx2.SyncByteStream = source
        self.chunks: list[bytes] = chunks

    @override
    def __iter__(self) -> Iterator[bytes]:
        for chunk in self.source:
            self.chunks.append(chunk)
            yield chunk

    @override
    def close(self) -> None:
        self.source.close()


def main(
    base_url: Annotated[str, typer.Option(help="URL du proxy incluant /v1.")],
    model: Annotated[str, typer.Option(help="Modèle à tester.")],
    key_file: Annotated[Path | None, typer.Option(help="Clé du proxy ; sinon OPENAI_API_KEY.")] = None,
    output_dir: Annotated[Path, typer.Option(help="Dossier des rapports.")] = DEFAULT_OUTPUT_DIR,
) -> None:
    """Responses 02 : consommer et vérifier le streaming SSE avec le SDK officiel."""
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
    chunks: list[bytes] = []
    events: list[ObservedEvent] = []
    checks: list[Check] = []
    response: httpx2.Response | None = None
    request: httpx2.Request | None = None
    unavailable = False
    started = perf_counter()
    first_delta: float | None = None
    completed: float | None = None

    def capture(received: httpx2.Response) -> None:
        nonlocal response, request
        response, request = received, received.request
        if not isinstance(received.stream, httpx2.SyncByteStream):
            raise TypeError("Expected synchronous SDK transport")
        received.stream = CapturedStream(received.stream, chunks)

    transport = openai.DefaultHttpxClient(follow_redirects=False, event_hooks={"response": [capture]})
    with openai.OpenAI(api_key=key, base_url=base_url.rstrip("/") + "/", max_retries=0, timeout=300, http_client=transport) as client:
        try:
            with client.responses.with_streaming_response.create(model=model, input=PROMPT, stream=True, store=False) as raw:
                if raw.headers.get("content-type", "").split(";")[0].strip().lower() != "text/event-stream":
                    _ = raw.read()
                    checks.append(Check(name="SDK streaming", passed=False, detail="Réponse non SSE"))
                else:
                    with raw.parse() as stream:
                        for event in stream:
                            elapsed = round(perf_counter() - started, 6)
                            events.append(ObservedEvent(type=event.type, elapsed_seconds=elapsed))
                            if event.type == "response.output_text.delta":
                                if first_delta is None:
                                    first_delta = elapsed
                                console.print(f"[{elapsed:.3f}s] Fragment texte reçu", markup=False)
                            elif event.type == "response.completed":
                                completed = elapsed
                                console.print(f"[{elapsed:.3f}s] Réponse terminée", markup=False)
                    checks.append(Check(name="SDK streaming", passed=True, detail=f"{len(events)} événements reçus par l’itérateur officiel"))
        except openai.APIConnectionError as error:
            request = error.request
            unavailable = True
            checks.append(Check(name="Connexion", passed=False, detail=type(error).__name__))
        except (openai.APIError, httpx2.TransportError, json.JSONDecodeError, UnicodeDecodeError, ValidationError) as error:
            checks.append(Check(name="Lecture du flux", passed=False, detail=type(error).__name__))
    wire = b"".join(chunks)
    content_type = response.headers.get("content-type", "") if response is not None else None
    checks.append(Check(name="HTTP", passed=response is not None and response.status_code == 200, detail=str(response.status_code) if response is not None else "Aucune réponse"))
    checks.append(Check(name="Content-Type", passed=content_type is not None and content_type.split(";")[0].strip().lower() == "text/event-stream", detail=content_type or "Absent"))
    try:
        stream_checks, text = evaluate_stream(wire)
        checks.extend(stream_checks)
    except UnicodeDecodeError:
        text = None
        checks.append(Check(name="Encodage SSE", passed=False, detail="UTF-8 invalide"))
    technical = all(check.passed is True for check in checks)
    behavior = text.strip() == "TEST_OK" if text is not None else None
    checks.append(Check(category="consigne", name="Texte attendu", passed=behavior, detail="TEST_OK" if behavior is not None else "Non évalué"))
    exit_code = 2 if unavailable else 0 if technical and behavior else 1
    timestamp = datetime.now(timezone.utc)
    headers = {name: value if name.lower() in {"accept", "content-type", "user-agent", "host"} else "[REDACTED]" for name, value in request.headers.items()} if request is not None else {}
    report = StreamReport(timestamp=timestamp.isoformat(), scenario="responses/stream", request_url=str(request.url) if request is not None else base_url.rstrip("/") + "/responses", request_headers=headers, request_body=request.content.decode() if request is not None else "", response_status=response.status_code if response is not None else None, response_content_type=content_type, response_body=wire.decode("utf-8", errors="replace") if response is not None else None, output_text=text, duration_seconds=round(perf_counter() - started, 3), checks=checks, technical_passed=technical, behavior_passed=behavior, exit_code=exit_code, events=events, first_delta_seconds=first_delta, completed_seconds=completed)
    serialized = report.model_dump_json(indent=2).replace(json.dumps(key)[1:-1], "[REDACTED]").replace(key, "[REDACTED]")
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"stream-{timestamp.strftime('%Y%m%dT%H%M%S%fZ')}.json"
        with path.open("x") as target:
            _ = target.write(serialized + "\n")
    except OSError as error:
        console.print(f"Rapport non enregistré : {error.strerror}", markup=False)
        raise typer.Exit(2) from error
    console.print(f"Texte reçu : {text.replace(key, '[REDACTED]') if text is not None else '(indisponible)'}", markup=False)
    table = Table("Catégorie", "Contrôle", "Verdict", "Détail")
    for check in checks:
        label = "PASS" if check.passed else "SKIP" if check.passed is None else "FAIL"
        style = "bold green" if check.passed else "yellow" if check.passed is None else "bold red"
        table.add_row(Text(check.category), Text(check.name), Text(label, style=style), Text(check.detail.replace(key, "[REDACTED]")))
    console.print(table)
    console.print(Text(f"Technique : {'CONFORME' if technical else 'ÉCHEC'} · Consigne : {'RESPECTÉE' if behavior else 'NON ÉVALUÉE' if behavior is None else 'NON RESPECTÉE'}", style="bold green" if exit_code == 0 else "bold red"))
    console.print(f"Rapport : {path}", markup=False)
    raise typer.Exit(exit_code)


if __name__ == "__main__":
    typer.run(main)
