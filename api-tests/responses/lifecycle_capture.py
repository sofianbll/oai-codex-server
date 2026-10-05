#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["openai==3.16.2", "pydantic>=2,<3"]
# ///

# ─── How to run ───
# 1. Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Import from another Responses scenario; dependencies are resolved by uv.
# 3. Run this file directly to print its import and usage contract.
# ──────────────────

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from enum import StrEnum
from types import TracebackType
from typing import TYPE_CHECKING, ClassVar, Generic, TypeVar, assert_never, final
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx2
import openai
from openai.types.responses import Response, ResponseCompletedEvent, ResponseStreamEvent
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError

if TYPE_CHECKING:
    from httpx2 import Request, Response as HttpResponse

T = TypeVar("T")
type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]
_JSON_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
_SECRET_NAME = re.compile(r"(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie|assertion)", re.IGNORECASE)
_SAFE_HEADERS = frozenset({"accept", "content-type", "host", "openai-beta", "user-agent", "x-client-request-id"})
_SECRET_TEXT = re.compile(r"(?i)(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie|assertion)(\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;]+)")
_BEARER = re.compile(r"(?i)\bBearer\s+[^\s\"']+")
_TOKEN = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{8,}|sess-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b")


class ErrorClass(StrEnum):
    NONE = "none"
    HTTP_STATUS = "http_status"
    NETWORK = "network_error"
    SDK = "sdk_error"
    INVALID_RESPONSE = "invalid_response"
    RESPONSE_SCHEMA = "response_schema_error"
    STREAM_INCOMPLETE = "stream_incomplete"


class CaptureReport(BaseModel):
    """Redacted wire evidence and independent technical/behavior verdicts."""

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)

    request_method: str | None
    request_url: str | None
    request_headers: dict[str, str]
    request_body: str | None
    response_status: int | None
    response_content_type: str | None
    response_body: str | None
    duration_seconds: float
    error_classification: ErrorClass
    error_detail: str | None
    strict_response_valid: bool | None
    stream_completed: bool | None
    technical_passed: bool
    behavior_passed: bool | None


@dataclass(frozen=True, slots=True)
class CapturedRun(Generic[T]):
    """The SDK result, when available, and its serializable capture report."""

    value: T | None
    report: CaptureReport


@dataclass(slots=True)  # noqa: MUTABLE_OK
class _Exchange:
    """Mutable per-call accumulator populated by SDK-owned HTTPX hooks."""

    started_at: float = 0.0
    request_method: str | None = None
    request_url: str | None = None
    request_headers: dict[str, str] | None = None
    request_body: str | None = None
    response_status: int | None = None
    response_content_type: str | None = None
    response_body: str | None = None
    raw_response_body: bytes | None = None
    error_classification: ErrorClass = ErrorClass.NONE
    error_detail: str | None = None
    strict_response_valid: bool | None = None
    stream_completed: bool | None = None


def _redact_text(value: str, secrets: tuple[str, ...]) -> str:
    """Remove known credentials and common bearer/token forms from text."""
    redacted = value
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    scrubbed = _TOKEN.sub("[REDACTED]", _BEARER.sub("Bearer [REDACTED]", redacted))
    return _SECRET_TEXT.sub(r"\1\2[REDACTED]", scrubbed)


def _redact_json(value: JsonValue, secrets: tuple[str, ...]) -> JsonValue:
    """Redact sensitive JSON fields while preserving the remaining shape."""
    match value:
        case dict() as record:
            return {
                key: "[REDACTED]" if _SECRET_NAME.search(key) else _redact_json(item, secrets)
                for key, item in record.items()
            }
        case list() as items:
            return [_redact_json(item, secrets) for item in items]
        case str() as text:
            return _redact_text(text, secrets)
        case None | bool() | int() | float():
            return value
        case unreachable:
            assert_never(unreachable)


def _safe_url(url: str, secrets: tuple[str, ...]) -> str:
    """Redact credentials in URL userinfo and sensitive query parameters."""
    parts = urlsplit(url)
    host = parts.netloc.rsplit("@", maxsplit=1)[-1]
    if parts.username is not None or parts.password is not None:
        host = f"[REDACTED]@{host}"
    query = urlencode(
        [
            (key, "[REDACTED]" if _SECRET_NAME.search(key) else _redact_text(value, secrets))
            for key, value in parse_qsl(parts.query, keep_blank_values=True)
        ]
    )
    return _redact_text(urlunsplit((parts.scheme, host, parts.path, query, parts.fragment)), secrets)


def _safe_body(body: bytes, secrets: tuple[str, ...]) -> str:
    """Return UTF-8 evidence with sensitive JSON values removed."""
    text = body.decode("utf-8", errors="replace")
    try:
        value = _JSON_ADAPTER.validate_python(json.loads(text))
    except (json.JSONDecodeError, ValidationError):
        return _redact_text(text, secrets)
    redacted = _redact_json(value, secrets)
    return json.dumps(redacted, ensure_ascii=False, separators=(",", ":"))


@final
class CaptureSession:
    """Reuse the official OpenAI SDK with retries disabled and redacted HTTP hooks."""

    def __init__(self, *, base_url: str, api_key: str, extra_secrets: tuple[str, ...] = ()) -> None:
        self._secrets: tuple[str, ...] = (api_key, *extra_secrets)
        self._exchange: _Exchange = _Exchange()
        self._client: openai.OpenAI = openai.OpenAI(
            api_key=api_key,
            base_url=base_url,
            max_retries=0,
            timeout=300,
            http_client=openai.DefaultHttpxClient(
                follow_redirects=False,
                event_hooks={"request": [self._on_request], "response": [self._on_response]},
            ),
        )

    def __enter__(self) -> CaptureSession: return self

    def __exit__(self, exc_type: type[BaseException] | None, error: BaseException | None, traceback: TracebackType | None) -> None:
        self.close()

    def close(self) -> None:
        """Close the SDK client and its HTTP transport."""
        self._client.close()

    def _reset(self) -> None: self._exchange = _Exchange(started_at=time.perf_counter())

    def _on_request(self, request: Request) -> None:
        self._exchange.request_method = request.method
        self._exchange.request_url = _safe_url(str(request.url), self._secrets)
        self._exchange.request_headers = {name.lower(): value if name.lower() in _SAFE_HEADERS else "[REDACTED]" for name, value in request.headers.items()}
        self._exchange.request_body = _safe_body(request.read(), self._secrets)

    def _on_response(self, response: HttpResponse) -> None:
        self._exchange.response_status = response.status_code
        self._exchange.response_content_type = response.headers.get("content-type")
        self._exchange.raw_response_body = response.read()
        self._exchange.response_body = _safe_body(self._exchange.raw_response_body, self._secrets)

    def _capture_error(self, error: openai.APIStatusError | openai.APIConnectionError | openai.APIError | httpx2.TimeoutException | json.JSONDecodeError | ValidationError) -> None:
        match error:
            case openai.APIStatusError():
                classification, detail = ErrorClass.HTTP_STATUS, f"HTTP {error.status_code}"
            case openai.APIConnectionError() | httpx2.TimeoutException():
                classification, detail = ErrorClass.NETWORK, type(error).__name__
            case openai.APIError():
                classification, detail = ErrorClass.SDK, type(error).__name__
            case json.JSONDecodeError():
                classification, detail = ErrorClass.INVALID_RESPONSE, "Malformed JSON response"
            case ValidationError():
                classification, detail = ErrorClass.RESPONSE_SCHEMA, "Response schema validation failed"
            case unreachable:
                assert_never(unreachable)
        self._exchange.error_classification, self._exchange.error_detail = classification, detail

    def _validate_response(self) -> Response | None:
        body = self._exchange.raw_response_body
        if body is None:
            self._exchange.strict_response_valid = False
            return None
        try:
            response = Response.model_validate_json(body, strict=True)
        except ValidationError:
            self._exchange.strict_response_valid = False
            self._exchange.error_classification = ErrorClass.RESPONSE_SCHEMA
            self._exchange.error_detail = "Response schema validation failed"
            return None
        except json.JSONDecodeError:
            self._exchange.strict_response_valid = False
            self._exchange.error_classification = ErrorClass.INVALID_RESPONSE
            self._exchange.error_detail = "Malformed JSON response"
            return None
        self._exchange.strict_response_valid = True
        return response

    def _report(self, behavior_passed: bool | None) -> CaptureReport:
        exchange = self._exchange
        if exchange.response_status is not None and not 200 <= exchange.response_status < 300 and exchange.error_classification is ErrorClass.NONE:
            exchange.error_classification = ErrorClass.HTTP_STATUS
            exchange.error_detail = f"HTTP {exchange.response_status}"
        duration = max(0.0, time.perf_counter() - exchange.started_at)
        technical = exchange.error_classification is ErrorClass.NONE and exchange.response_status is not None and 200 <= exchange.response_status < 300 and exchange.strict_response_valid is not False and exchange.stream_completed is not False
        return CaptureReport(
            request_method=exchange.request_method,
            request_url=exchange.request_url,
            request_headers=exchange.request_headers or {},
            request_body=exchange.request_body,
            response_status=exchange.response_status,
            response_content_type=exchange.response_content_type,
            response_body=exchange.response_body,
            duration_seconds=round(duration, 6),
            error_classification=exchange.error_classification,
            error_detail=exchange.error_detail,
            strict_response_valid=exchange.strict_response_valid,
            stream_completed=exchange.stream_completed,
            technical_passed=technical,
            behavior_passed=behavior_passed,
        )

    def call(
        self,
        invoke: Callable[[openai.OpenAI], T],
        *,
        validate_response: bool = False,
        behavior_check: Callable[[T | None], bool | None] | None = None,
    ) -> CapturedRun[T]:
        """Capture one ordinary SDK operation; validate JSON Response when requested."""
        self._reset()
        value: T | None = None
        try:
            value = invoke(self._client)
        except (openai.APIStatusError, openai.APIConnectionError, openai.APIError, httpx2.TimeoutException, json.JSONDecodeError, ValidationError) as error:
            self._capture_error(error)
        if validate_response and self._exchange.response_status is not None and 200 <= self._exchange.response_status < 300:
            _ = self._validate_response()
        behavior = behavior_check(value) if behavior_check is not None else None
        return CapturedRun(value=value, report=self._report(behavior))

    def stream(
        self,
        invoke: Callable[[openai.OpenAI], Iterable[ResponseStreamEvent]],
        *,
        behavior_check: Callable[[Response | None], bool | None] | None = None,
    ) -> CapturedRun[Response]:
        """Consume a Responses stream and require a strict `response.completed` item."""
        self._reset()
        final_response: Response | None = None
        completion_seen = False
        try:
            events: Iterator[ResponseStreamEvent] = iter(invoke(self._client))
            for event in events:
                if isinstance(event, ResponseCompletedEvent) and not completion_seen:
                    completion_seen = True
                    final_response = event.response
                    try:
                        final_response = Response.model_validate_json(final_response.model_dump_json(), strict=True)
                    except ValidationError:
                        self._exchange.strict_response_valid = False
                        self._exchange.error_classification = ErrorClass.RESPONSE_SCHEMA
                        self._exchange.error_detail = "Completed stream response failed strict schema validation"
                    else:
                        self._exchange.strict_response_valid = True
            if not completion_seen:
                self._exchange.stream_completed = False
                self._exchange.error_classification = ErrorClass.STREAM_INCOMPLETE
                self._exchange.error_detail = "Stream ended without response.completed"
            else:
                self._exchange.stream_completed = True
        except (openai.APIStatusError, openai.APIConnectionError, openai.APIError, httpx2.TimeoutException, json.JSONDecodeError, ValidationError) as error:
            self._capture_error(error)
        behavior = behavior_check(final_response) if behavior_check is not None else None
        return CapturedRun(value=final_response, report=self._report(behavior))

def main() -> None: print("Import CaptureSession from lifecycle_capture in a Responses scenario script.")


if __name__ == "__main__":
    main()
