#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["openai==3.16.2", "httpx2>=0.3", "typer>=0.16,<1"]
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Verify payload identity locally:
#      uv run docs/evidence/responses-gap-research/cache_probe.py --self-test
# 3. Run live only after the runtime target is verified:
#      uv run docs/evidence/responses-gap-research/cache_probe.py --live --base-url http://127.0.0.1:8788/v1 --model gpt-6-astra --key-file .local/server-token
# ──────────────────

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from time import perf_counter
from typing import Final

import httpx2
import openai
import typer
from openai.types.responses import ResponseCompletedEvent

_REDACTED: Final = "[REDACTED]"
_SAFE_VALUES: Final = frozenset({"accept", "content-type", "user-agent", "host"})
_HASHED_VALUES: Final = frozenset({"session-id", "thread-id", "chatgpt-account-id", "x-client-request-id"})
_PREFIX_WORDS: Final = 1800


@dataclass(slots=True)
class WireCapture:
    request_headers: dict[str, str] = field(default_factory=dict)
    request_body: bytes = b""
    response_status: int | None = None
    response_content_type: str | None = None
    duration_seconds: float = 0.0
    usage: dict[str, object] | None = None


def digest(value: bytes | str) -> str:
    raw = value if isinstance(value, bytes) else value.encode()
    return f"sha256:{hashlib.sha256(raw).hexdigest()[:16]}"


def scrub_headers(headers: httpx2.Headers) -> dict[str, str]:
    result: dict[str, str] = {}
    for name, value in headers.items():
        lowered = name.lower()
        if lowered in _SAFE_VALUES:
            result[lowered] = value
        elif lowered in _HASHED_VALUES or lowered.startswith("x-openai-"):
            result[lowered] = digest(value)
        elif "authorization" in lowered or "token" in lowered or "key" in lowered or "cookie" in lowered:
            result[lowered] = _REDACTED
        else:
            result[lowered] = "[PRESENT]"
    return result


def payload(cache_key: str) -> tuple[dict[str, object], str]:
    source_input = ("cache " * _PREFIX_WORDS) + "\nReply exactly 42."
    return (
        {
            "model": "",
            "input": [{"role": "user", "content": source_input}],
            "instructions": "Reply only with 42.",
            "prompt_cache_key": cache_key,
            "store": False,
            "stream": True,
        },
        source_input,
    )


def usage_snapshot(event: ResponseCompletedEvent) -> dict[str, object]:
    usage = event.response.usage
    if usage is None:
        return {
            "usage_present": False,
            "input_tokens": {"present": False, "value": None},
            "output_tokens": {"present": False, "value": None},
            "cached_tokens": {"present": False, "value": None},
            "cache_read_input_tokens": {"present": False, "value": None},
            "cache_write_input_tokens": {"present": False, "value": None},
        }
    raw = usage.model_dump(mode="json", exclude_none=False)
    attribution = raw.get("attribution")
    if isinstance(attribution, dict):
        items = attribution.get("items")
        if isinstance(items, dict):
            attribution["items"] = {
                digest(item_id): item_value for item_id, item_value in items.items()
            }
    details = raw.get("input_tokens_details")
    if not isinstance(details, dict):
        details = {}
    counters = {
        name: {"present": name in details, "value": details.get(name)}
        for name in ("cached_tokens", "cache_read_input_tokens", "cache_write_input_tokens")
    }
    return {
        "usage_present": True,
        "all_nonsecret_usage_fields": raw,
        "input_tokens": {"present": "input_tokens" in raw, "value": raw.get("input_tokens")},
        "output_tokens": {"present": "output_tokens" in raw, "value": raw.get("output_tokens")},
        **counters,
    }


def send_once(
    *, base_url: str, api_key: str, model: str, body: dict[str, object], session_id: str | None
) -> WireCapture:
    capture = WireCapture()
    started = perf_counter()

    def request_hook(request: httpx2.Request) -> None:
        capture.request_headers = scrub_headers(request.headers)
        capture.request_body = request.read()

    def response_hook(response: httpx2.Response) -> None:
        capture.response_status = response.status_code
        capture.response_content_type = response.headers.get("content-type")

    headers = {"session-id": session_id} if session_id is not None else {}
    transport = openai.DefaultHttpxClient(
        follow_redirects=False,
        event_hooks={"request": [request_hook], "response": [response_hook]},
    )
    request_body = {**body, "model": model}
    with openai.OpenAI(api_key=api_key, base_url=base_url.rstrip("/") + "/", max_retries=0, timeout=300, default_headers=headers, http_client=transport) as client:
        try:
            with client.responses.with_streaming_response.create(**request_body) as raw:
                with raw.parse() as stream:
                    for event in stream:
                        if isinstance(event, ResponseCompletedEvent):
                            capture.usage = usage_snapshot(event)
        except openai.APIStatusError:
            pass
        except openai.APIConnectionError:
            pass
    capture.duration_seconds = round(perf_counter() - started, 6)
    return capture


class FixtureHandler(BaseHTTPRequestHandler):
    bodies: list[bytes] = []

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers["content-length"])
        type(self).bodies.append(self.rfile.read(length))
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":{"message":"fixture"}}')

    def log_message(self, _format: str, *_args: object) -> None:
        return


def self_test() -> dict[str, object]:
    FixtureHandler.bodies = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        cache_key = "self-test-cache-key"
        body, source_input = payload(cache_key)
        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        first = send_once(base_url=base_url, api_key="fixture", model="fixture", body=body, session_id=None)
        second = send_once(base_url=base_url, api_key="fixture", model="fixture", body=body, session_id=None)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    return {
        "self_test": True,
        "model_calls": 0,
        "fixture_statuses": [first.response_status, second.response_status],
        "fixture_received_count": len(FixtureHandler.bodies),
        "same_payload_bytes": len(FixtureHandler.bodies) == 2 and FixtureHandler.bodies[0] == FixtureHandler.bodies[1],
        "source_input_utf8_bytes": len(source_input.encode()),
        "source_input_sha256": digest(source_input),
        "request_body_sha256": digest(FixtureHandler.bodies[0]) if FixtureHandler.bodies else None,
        "first_safe_headers": first.request_headers,
        "second_safe_headers": second.request_headers,
    }


def main(
    self_test_mode: bool = typer.Option(False, "--self-test"),
    live: bool = typer.Option(False, "--live"),
    base_url: str = typer.Option("http://127.0.0.1:8788/v1"),
    model: str = typer.Option("gpt-6-astra"),
    key_file: Path | None = typer.Option(None),
) -> None:
    if self_test_mode:
        typer.echo(json.dumps(self_test(), sort_keys=True))
        return
    if not live:
        raise typer.BadParameter("Choose --self-test or explicitly authorized --live.")
    if key_file is None:
        raise typer.BadParameter("--key-file is required for --live.")
    api_key = key_file.read_text(encoding="utf-8").strip()
    cache_key = "cache-ab-" + secrets.token_hex(12)
    body, source_input = payload(cache_key)
    results = []
    for label, session_id in (("baseline", None), ("session_id_equals_key", cache_key)):
        for index in range(2):
            captured = send_once(base_url=base_url, api_key=api_key, model=model, body=body, session_id=session_id)
            results.append(
                {
                    "variant": label,
                    "ordinal": index + 1,
                    "request_body_sha256": digest(captured.request_body),
                    "request_headers": captured.request_headers,
                    "response_status": captured.response_status,
                    "response_content_type": captured.response_content_type,
                    "duration_seconds": captured.duration_seconds,
                    "usage": captured.usage
                }
            )
    typer.echo(
        json.dumps(
            {
                "self_test": False,
                "model_calls": 4,
                "source_input_utf8_bytes": len(source_input.encode()),
                "source_input_sha256": digest(source_input),
                "prompt_cache_key_sha256": digest(cache_key),
                "remote_target": "not observable from a proxy client",
                "account_fingerprint": "not observable from a proxy client",
                "results": results,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    typer.run(main)
