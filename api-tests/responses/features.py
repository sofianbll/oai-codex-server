# /// script
# requires-python = ">=3.11"
# dependencies = ["openai==3.16.2", "pydantic>=2,<3", "typer>=0.16,<1"]
# ///
from __future__ import annotations

import base64
import json
import os
import struct
import zlib
from datetime import datetime, timezone
from pathlib import Path
from secrets import token_hex
from typing import Annotated, Literal
from urllib.parse import urlsplit

import openai
import typer
from pydantic import BaseModel, ConfigDict, TypeAdapter
from openai.types.responses import FunctionToolParam, ResponseInputItemParam, ResponseReasoningItemParam, ResponseTextConfigParam
from test_features import Attempt, ResponsePayload, call, redacted

DEFAULT_OUTPUT_DIR = Path(__file__).parent / "results"
Scenario = Literal["instructions", "parameters", "json-object", "json-schema", "function", "tool-choice", "parallel-tools", "reasoning-replay", "cache", "image", "builtins", "native-media", "web-search"]
CACHE_STABLE_PREFIX = "\n".join(["Cache verification context: keep every word in this immutable prefix identical across both Requests responses calls."] * 160)


class FeatureReport(BaseModel):
    model_config = ConfigDict(frozen=True)
    timestamp: str
    scenario: str
    sdk_version: str
    model: str
    proxy_mode: str = "configured proxy behavior (raw/minimal is server-owned)"
    attempts: list[Attempt]
    technical_passed: bool | None
    behavior_passed: bool | None
    exit_code: int


def base(model: str, prompt: str) -> ResponsePayload:
    return {"model": model, "input": prompt, "stream": False, "store": False}


def with_params(base_payload: ResponsePayload, extra: ResponsePayload) -> ResponsePayload:
    base_payload.update(extra)
    return base_payload


def semantic(attempt: Attempt, expected: str) -> bool:
    return attempt.verdict == "accepted" and (attempt.output_text or "").strip() == expected


def cache_read_hit(attempt: Attempt) -> bool:
    usage = attempt.usage
    if usage is None or usage.input_tokens is None or usage.input_tokens <= 0:
        return False
    cached_read = usage.cached_read
    return cached_read.state == "value" and cached_read.value is not None and 0 < cached_read.value <= usage.input_tokens


def run(client: openai.OpenAI, scenario: Scenario, model: str) -> tuple[list[Attempt], bool | None]:
    if scenario == "instructions":
        token = f"INSTRUCTION_{token_hex(3)}"
        omitted = call(client, "instructions omitted", base(model, "Réponds exactement OMIT_OK"))
        null = call(client, "instructions null", {**base(model, "Réponds exactement NULL_OK"), "instructions": None})
        value = call(client, "instruction value", {**base(model, "Réponds uniquement avec le mot demandé."), "instructions": f"Réponds exactement {token}."})
        return [omitted.attempt, null.attempt, value.attempt], all((semantic(omitted.attempt, "OMIT_OK"), semantic(null.attempt, "NULL_OK"), semantic(value.attempt, token)))
    if scenario == "parameters":
        variants: list[tuple[str, ResponsePayload]] = [("temperature", {"temperature": 0}), ("top_p", {"top_p": 1}), ("max_output_tokens", {"max_output_tokens": 32}), ("text.verbosity", {"text": {"verbosity": "low"}})]
        attempts = [call(client, name, with_params(base(model, "Réponds exactement PARAM_OK"), extra)) for name, extra in variants]
        return [item.attempt for item in attempts], all(semantic(item.attempt, "PARAM_OK") for item in attempts)
    if scenario in {"json-object", "json-schema"}:
        fmt: ResponseTextConfigParam = {"format": {"type": "json_object"}} if scenario == "json-object" else {"format": {"type": "json_schema", "name": "answer", "strict": True, "schema": {"type": "object", "properties": {"answer": {"type": "integer", "const": 42}}, "required": ["answer"], "additionalProperties": False}}}
        result = call(client, scenario, with_params(base(model, 'Réponds au format JSON exactement avec {"answer":42}.'), {"text": fmt}))
        try:
            valid = json.loads(result.attempt.output_text or "") == {"answer": 42}
        except json.JSONDecodeError:
            valid = False
        return [result.attempt], result.attempt.verdict == "accepted" and valid
    if scenario in {"function", "tool-choice", "parallel-tools"}:
        tools: list[FunctionToolParam] = [{"type": "function", "name": "answer", "description": "Return the requested integer.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}, "strict": False}]
        if scenario == "parallel-tools":
            tools.append({"type": "function", "name": "answer_second", "description": "Return the requested integer.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}, "strict": False})
        payload = base(model, "Utilise l’outil answer, puis donne uniquement son résultat.")
        payload["tools"] = tools
        if scenario == "tool-choice": payload["tool_choice"] = {"type": "function", "name": "answer"}
        if scenario == "parallel-tools":
            payload["tool_choice"] = "required"
            payload["parallel_tool_calls"] = True
            payload["input"] = "Appelle answer et answer_second, puis réponds uniquement 42."
        first = call(client, f"{scenario} function call", payload)
        functions = [item for item in (first.response.output if first.response else []) if item.type == "function_call"]
        if not functions:
            return [first.attempt], False if first.attempt.verdict == "accepted" else None
        calls: list[ResponseInputItemParam] = [{"type": "function_call", "call_id": item.call_id, "name": item.name, "arguments": item.arguments} for item in functions]
        outputs: list[ResponseInputItemParam] = [{"type": "function_call_output", "call_id": item.call_id, "output": "42"} for item in functions]
        second = call(client, f"{scenario} function output", with_params(base(model, "Réponds uniquement avec le résultat de l’outil."), {"input": [*calls, *outputs]}))
        enough_calls = len(functions) >= 2 if scenario == "parallel-tools" else len(functions) == 1
        return [first.attempt, second.attempt], enough_calls and semantic(second.attempt, "42")
    if scenario == "cache":
        key = f"safe-cache-{token_hex(3)}"
        prompt = f"{CACHE_STABLE_PREFIX}\nRéponds exactement CACHE_OK."
        first = call(client, "prompt cache first", {**base(model, prompt), "prompt_cache_key": key})
        second = call(client, "prompt cache repeat", {**base(model, prompt), "prompt_cache_key": key})
        return [first.attempt, second.attempt], semantic(first.attempt, "CACHE_OK") and semantic(second.attempt, "CACHE_OK") and cache_read_hit(second.attempt)
    if scenario == "reasoning-replay":
        first = call(client, "reasoning source", {**base(model, "Réponds exactement REASON_OK"), "reasoning": {"effort": "low"}, "include": ["reasoning.encrypted_content"]})
        item = next((entry for entry in (first.response.output if first.response else []) if entry.type == "reasoning" and getattr(entry, "encrypted_content", None)), None)
        if item is None:
            return [first.attempt.model_copy(update={"detail": "status accepted; encrypted_content requested by include was not exposed"})], None
        replay: ResponseReasoningItemParam = TypeAdapter(ResponseReasoningItemParam).validate_python(item.model_dump(mode="json", exclude_none=True))
        replay_input: list[ResponseInputItemParam] = [replay, {"role": "user", "content": "Réponds exactement REPLAY_OK"}]
        second = call(client, "encrypted reasoning replay", with_params(base(model, "Réponds exactement REPLAY_OK"), {"input": replay_input}))
        return [first.attempt, second.attempt], semantic(second.attempt, "REPLAY_OK")
    if scenario == "image":
        row = b"\0" + b"\xff\0\0" * 64
        chunk = lambda name, data: struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xffffffff)
        image = base64.b64encode(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * 64)) + chunk(b"IEND", b"")).decode()
        payload = base(model, "Quelle est la couleur du carré ? Réponds uniquement en français.")
        image_input: ResponseInputItemParam = TypeAdapter(ResponseInputItemParam).validate_python({"role": "user", "content": [{"type": "input_text", "text": "Quelle est la couleur du carré ?"}, {"type": "input_image", "image_url": f"data:image/png;base64,{image}", "detail": "auto"}]})
        payload["input"] = [image_input]
        result = call(client, "data URL red image", payload)
        return [result.attempt], result.attempt.verdict == "accepted" and "rouge" in (result.attempt.output_text or "").lower()
    if scenario == "native-media":
        inline = base64.b64encode(b"Known inline text: FILE_OK").decode()
        file_input: ResponseInputItemParam = TypeAdapter(ResponseInputItemParam).validate_python({"role": "user", "content": [{"type": "input_text", "text": "Lis le fichier."}, {"type": "input_file", "filename": "known.txt", "file_data": f"data:text/plain;base64,{inline}"}]})
        result = call(client, "inline base64 file", with_params(base(model, "Lis le fichier et réponds uniquement FILE_OK."), {"input": [file_input]}))
        return [result.attempt], result.attempt.verdict == "accepted" and "FILE_OK" in (result.attempt.output_text or "")
    if scenario == "web-search":
        result = call(client, "web_search_preview", {**base(model, "Search the web for the official OpenAI homepage and cite its URL."), "tools": [{"type": "web_search_preview"}], "tool_choice": "required"})
        output = result.response.output if result.response else []
        searched = any(item.type == "web_search_call" for item in output)
        cited = any(annotation.type == "url_citation" for item in output if item.type == "message" for content in item.content if content.type == "output_text" for annotation in content.annotations)
        return [result.attempt], result.attempt.verdict == "accepted" and searched and cited
    web = call(client, "web search", {**base(model, "Cherche le mot OpenAI puis réponds uniquement WEB_OK."), "tools": [{"type": "web_search_preview"}]})
    code = call(client, "code interpreter", {**base(model, "Utilise Python pour calculer 40+2 puis réponds uniquement 42."), "tools": [{"type": "code_interpreter", "container": {"type": "auto"}}]})
    image = call(client, "image generation", {**base(model, "Génère une image rouge minuscule."), "tools": [{"type": "image_generation"}]})
    output = next((item for item in (image.response.output if image.response else []) if item.type == "image_generation_call"), None)
    encoded = getattr(output, "result", None)
    image_ok = isinstance(encoded, str) and base64.b64decode(encoded, validate=True).startswith(b"\x89PNG\r\n\x1a\n")
    image_attempt = image.attempt.model_copy(update={"detail": f"{image.attempt.detail}; native_png_signature={image_ok}"})
    missing = Attempt(name="file search and MCP prerequisites", request_body="{}", status=None, content_type=None, response_body=None, output_text=None, verdict="prerequisite_missing", detail="file_search needs a configured vector store; MCP needs an explicitly configured server", duration_seconds=0)
    return [web.attempt, code.attempt, image_attempt, missing], None


def main(
    scenario: Annotated[Scenario, typer.Option(help="Capacité Responses à vérifier.")],
    base_url: Annotated[str, typer.Option(help="URL du proxy incluant /v1.")],
    model: Annotated[str, typer.Option(help="Modèle à tester.")],
    key_file: Annotated[Path | None, typer.Option(help="Clé du proxy ; sinon OPENAI_API_KEY.")] = None,
    output_dir: Annotated[Path, typer.Option(help="Dossier des rapports JSON.")] = DEFAULT_OUTPUT_DIR,
) -> None:
    url = urlsplit(base_url)
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment or url.path.rstrip("/") != "/v1":
        raise typer.BadParameter("URL HTTP(S) terminée par /v1, sans identifiants, paramètres ni fragment.")
    key = key_file.read_text().strip() if key_file else os.environ.get("OPENAI_API_KEY", "").strip()
    if not key or not model.strip(): raise typer.BadParameter("Définir une clé et un modèle non vide.")
    with openai.OpenAI(api_key=key, base_url=base_url.rstrip("/")+"/", max_retries=0, timeout=300, http_client=openai.DefaultHttpxClient(follow_redirects=False)) as client:
        attempts, behavior = run(client, scenario, model)
    technical = all(item.verdict in {"accepted", "prerequisite_missing"} for item in attempts)
    exit_code = 2 if any(item.verdict == "transport_unavailable" for item in attempts) else 0 if technical and behavior else 1
    now = datetime.now(timezone.utc)
    report = FeatureReport(timestamp=now.isoformat(), scenario=f"responses/features/{scenario}", sdk_version=openai.__version__, model=model, attempts=attempts, technical_passed=technical, behavior_passed=behavior, exit_code=exit_code)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"features-{scenario}-{now.strftime('%Y%m%dT%H%M%S%fZ')}.json"
    path.write_text(redacted(report.model_dump_json(indent=2), key) + "\n")
    for item in attempts: typer.echo(f"{item.name}: {item.verdict} ({item.detail})")
    typer.echo(f"Rapport : {path}")
    raise typer.Exit(exit_code)


if __name__ == "__main__": typer.run(main)
