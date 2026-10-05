from __future__ import annotations

from itertools import pairwise

from openai._streaming import SSEDecoder
from openai.types.responses import Response, ResponseStreamEvent
from pydantic import TypeAdapter, ValidationError
from test_create_text import Check, contract_checks

EVENT_SCHEMA: TypeAdapter[ResponseStreamEvent] = TypeAdapter(ResponseStreamEvent)


def evaluate_stream(wire: bytes) -> tuple[list[Check], str | None]:
    checks: list[Check] = []
    issues: list[str] = []
    types: list[str] = []
    sequences: list[int] = []
    deltas: dict[tuple[int, int, str], str] = {}
    done: dict[tuple[int, int, str], str] = {}
    final: Response | None = None
    created_id: str | None = None
    ordering = True
    marker = False
    for frame in SSEDecoder().iter_bytes(iter([wire])):
        if frame.data == "[DONE]":
            ordering = ordering and final is not None
            marker = True
            continue
        try:
            event = EVENT_SCHEMA.validate_json(frame.data, strict=True)
        except ValidationError as error:
            issues.append("; ".join(f"{'.'.join(map(str, item['loc']))}: {item['type']}" for item in error.errors(include_input=False, include_url=False)))
            continue
        ordering = ordering and not marker and final is None
        if frame.event and frame.event != event.type:
            issues.append("Le nom SSE diffère du type JSON")
        types.append(event.type)
        sequences.append(event.sequence_number)
        if event.type == "response.created":
            created_id = event.response.id
        if event.type == "response.output_text.delta":
            key = (event.output_index, event.content_index, event.item_id)
            ordering = ordering and key not in done
            deltas[key] = deltas.get(key, "") + event.delta
        if event.type == "response.output_text.done":
            key = (event.output_index, event.content_index, event.item_id)
            ordering = ordering and key not in done
            done[key] = event.text
        if event.type == "response.completed":
            final = event.response
    checks.append(Check(name="Schéma des événements", passed=bool(types) and not issues, detail="; ".join(issues) if issues else f"{len(types)} événements validés avec le schéma officiel"))
    lifecycle = bool(types) and types[0] == "response.created" and types[-1] == "response.completed" and types.count("response.created") == 1 and types.count("response.completed") == 1 and not any(t in {"error", "response.failed", "response.incomplete"} for t in types)
    checks.append(Check(name="Cycle du flux", passed=lifecycle, detail="Une création, une fin completed, aucune erreur"))
    checks.append(Check(name="Ordre", passed=ordering and all(a < b for a, b in pairwise(sequences)), detail="Numéros croissants, fragments avant done, completed en dernier"))
    checks.append(Check(name="Fragments texte", passed=bool(deltas) and deltas == done, detail="Fragments présents et identiques aux textes output_text.done"))
    if final is None:
        checks.append(Check(name="Réponse finale", passed=False, detail="response.completed absent ou invalide"))
        return checks, None
    expected: dict[tuple[int, int, str], str] = {}
    for output_index, item in enumerate(final.output):
        if item.type == "message":
            for content_index, content in enumerate(item.content):
                if content.type == "output_text":
                    expected[(output_index, content_index, item.id)] = content.text
    checks.append(Check(name="Cohérence finale", passed=created_id == final.id and bool(expected) and expected == deltas, detail="ID de réponse, IDs des messages, index et texte final concordants"))
    contract, text = contract_checks(final.model_dump_json(), final)
    checks.extend(contract)
    return checks, text
