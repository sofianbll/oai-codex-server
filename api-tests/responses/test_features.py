# /// script
# requires-python = ">=3.11"
# dependencies = ["openai==3.16.2", "pydantic>=2,<3", "typer>=0.16,<1"]
# ///
from __future__ import annotations

import json
from dataclasses import dataclass
from time import perf_counter
from typing import Literal, TypeAlias

import openai
from openai.types.responses import Response
from openai.types.responses.response_create_params import ResponseCreateParamsNonStreaming
from pydantic import BaseModel, ConfigDict, JsonValue, TypeAdapter, ValidationError


class Attempt(BaseModel):
    model_config = ConfigDict(frozen=True)
    name: str
    request_body: str
    status: int | None
    content_type: str | None
    response_body: str | None
    output_text: str | None
    verdict: str
    detail: str
    duration_seconds: float
    usage: UsageObservation | None = None


class CacheCounter(BaseModel):
    model_config = ConfigDict(frozen=True)
    state: Literal["absent", "null", "value", "malformed"]
    value: int | None = None


class UsageObservation(BaseModel):
    model_config = ConfigDict(frozen=True)
    raw_usage_present: bool
    input_tokens: int | None
    cached_read: CacheCounter
    cache_write: CacheCounter


@dataclass(frozen=True, slots=True)
class CallResult:
    attempt: Attempt
    response: Response | None


ResponsePayload: TypeAlias = ResponseCreateParamsNonStreaming
JSON_VALUE: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
PAYLOAD_ADAPTER: TypeAdapter[ResponsePayload] = TypeAdapter(ResponseCreateParamsNonStreaming)


def output_text(response: Response | None) -> str | None:
    return response.output_text if response is not None else None


def scrub(value: JsonValue) -> JsonValue:
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, dict):
        return {key: "[REDACTED]" if key == "encrypted_content" else "[REDACTED_BINARY]" if key == "result" and isinstance(item, str) and len(item) > 1024 else scrub(item) for key, item in value.items()}
    return value


def safe_body(body: str) -> str:
    try:
        parsed = JSON_VALUE.validate_json(body)
    except ValidationError:
        return body
    return json.dumps(scrub(parsed), ensure_ascii=False, separators=(",", ":"))


def observed_counter(usage: JsonValue | None, field: str) -> CacheCounter:
    if usage is None:
        return CacheCounter(state="absent")
    match usage:
        case dict() as mapping:
            details = mapping.get("input_tokens_details")
            match details:
                case None:
                    return CacheCounter(state="absent")
                case dict() as detail_mapping:
                    if field not in detail_mapping:
                        return CacheCounter(state="absent")
                    match detail_mapping[field]:
                        case None:
                            return CacheCounter(state="null")
                        case bool():
                            return CacheCounter(state="malformed")
                        case int() as value:
                            return CacheCounter(state="value", value=value)
                        case _:
                            return CacheCounter(state="malformed")
                case _:
                    return CacheCounter(state="malformed")
        case _:
            return CacheCounter(state="malformed")


def observed_input_tokens(usage: JsonValue | None) -> int | None:
    if not isinstance(usage, dict):
        return None
    value = usage.get("input_tokens")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def observe_usage(body: str) -> UsageObservation | None:
    try:
        document = JSON_VALUE.validate_json(body)
    except ValidationError:
        return None
    if not isinstance(document, dict):
        return None
    raw_usage = document.get("usage")
    return UsageObservation(
        raw_usage_present="usage" in document,
        input_tokens=observed_input_tokens(raw_usage),
        cached_read=observed_counter(raw_usage, "cached_tokens"),
        cache_write=observed_counter(raw_usage, "cache_write_tokens"),
    )


def call(client: openai.OpenAI, name: str, payload: ResponsePayload) -> CallResult:
    started = perf_counter()
    request_body = safe_body(PAYLOAD_ADAPTER.dump_json(payload, by_alias=True).decode())
    try:
        raw = client.responses.with_raw_response.create(**payload)
    except openai.APIConnectionError as error:
        return CallResult(Attempt(name=name, request_body=request_body, status=None, content_type=None,
            response_body=None, output_text=None, verdict="transport_unavailable",
            detail=type(error).__name__, duration_seconds=round(perf_counter() - started, 3)), None)
    except openai.APIStatusError as error:
        response = error.response
        return CallResult(Attempt(name=name, request_body=request_body, status=response.status_code,
            content_type=response.headers.get("content-type"), response_body=safe_body(response.text),
            output_text=None, verdict="upstream_rejected",
            detail=f"HTTP {response.status_code}", duration_seconds=round(perf_counter() - started, 3)), None)
    response = raw.http_response
    content_type = response.headers.get("content-type", "")
    if response.status_code != 200 or content_type.split(";", 1)[0].strip().lower() != "application/json":
        return CallResult(Attempt(name=name, request_body=request_body, status=response.status_code,
            content_type=content_type, response_body=safe_body(response.text), output_text=None,
            verdict="http_or_content_type_invalid", detail=f"HTTP {response.status_code}; {content_type}",
            duration_seconds=round(perf_counter() - started, 3)), None)
    usage = observe_usage(response.text)
    try:
        _ = raw.parse()
        parsed = Response.model_validate_json(response.text, strict=True)
    except (openai.APIResponseValidationError, json.JSONDecodeError, ValidationError) as error:
        return CallResult(Attempt(name=name, request_body=request_body, status=response.status_code,
            content_type=response.headers.get("content-type"), response_body=safe_body(response.text),
            output_text=None, verdict="sdk_or_contract_invalid", detail=type(error).__name__,
            duration_seconds=round(perf_counter() - started, 3), usage=usage), None)
    valid = parsed.status == "completed" and parsed.error is None
    return CallResult(Attempt(name=name, request_body=request_body, status=response.status_code,
        content_type=response.headers.get("content-type"), response_body=safe_body(response.text),
        output_text=output_text(parsed), verdict="accepted" if valid else "incomplete_response",
        detail=f"status={parsed.status}; raw_usage_present={usage.raw_usage_present if usage else None}; cached_read={usage.cached_read.state if usage else None}",
        duration_seconds=round(perf_counter() - started, 3), usage=usage), parsed)


def redacted(value: str, key: str) -> str:
    return value.replace(json.dumps(key)[1:-1], "[REDACTED]").replace(key, "[REDACTED]")
