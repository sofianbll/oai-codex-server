from __future__ import annotations

from dataclasses import dataclass
from json import JSONDecodeError
from secrets import token_hex
from typing import Callable, Literal, TypeVar

from lifecycle_capture import CaptureReport, CaptureSession, CapturedRun
from openai.types.responses import Response, ResponseInputParam
from openai.types.responses.response_create_params import ResponseCreateParamsStreaming
from pydantic import JsonValue, TypeAdapter

Scenario = Literal["previous-response", "conversation", "retrieve", "delete", "background-cancel", "input-tokens", "compact", "store-json"]
T = TypeVar("T")
RESPONSE_INPUT = TypeAdapter(ResponseInputParam)
JSON_VALUE: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)


@dataclass(frozen=True, slots=True)
class Operation:
    name: str
    report: CaptureReport
    functional_passed: bool | None


@dataclass(frozen=True, slots=True)
class ScenarioExecution:
    operations: tuple[Operation, ...]
    resource_ids: tuple[str, ...]

    @property
    def functional_passed(self) -> bool | None:
        results = tuple(operation.functional_passed for operation in self.operations)
        if any(result is False for result in results):
            return False
        if results and all(result is True for result in results):
            return True
        return None


def _secret(kind: str) -> str:
    return f"LIFECYCLE_{kind}_{token_hex(12)}"


def _operation(name: str, run: CapturedRun[T], check: Callable[[T], bool] | None = None) -> Operation:
    behavior = run.report.technical_passed if check is None else run.value is not None and check(run.value)
    return Operation(name=name, report=run.report, functional_passed=behavior)


def _create(
    session: CaptureSession,
    model: str,
    message: str,
    previous_response_id: str | None = None,
    store: bool = False,
) -> CapturedRun[Response]:
    input_items: ResponseInputParam = RESPONSE_INPUT.validate_python(
        [{"role": "user", "content": message}]
    )
    payload: ResponseCreateParamsStreaming = {
        "model": model,
        "input": input_items,
        "instructions": "Follow the user instruction exactly.",
        "store": store,
        "stream": True,
    }
    if previous_response_id is not None:
        payload["previous_response_id"] = previous_response_id
    return session.stream(
        lambda client: client.responses.create(**payload)
    )


def _previous_response(session: CaptureSession, model: str) -> ScenarioExecution:
    secret = _secret("PREVIOUS")
    source = _create(session, model, f"Remember {secret}; reply only ACK.")
    operations = [_operation("create source store=false", source, lambda value: value.output_text.strip() == "ACK")]
    if source.value is None:
        return ScenarioExecution(tuple(operations), ())
    source_response = source.value
    follow = _create(session, model, "Reply only with the remembered secret.", previous_response_id=source_response.id)
    operations.append(_operation("create previous_response_id", follow, lambda response: response.output_text.strip() == secret))
    return ScenarioExecution(tuple(operations), (source_response.id,))


def _conversation(session: CaptureSession, model: str) -> ScenarioExecution:
    secret = _secret("CONVERSATION")
    created = session.call(lambda client: client.conversations.create())
    first = _operation("create conversation", created, lambda value: isinstance(getattr(value, "id", None), str))
    if created.value is None:
        return ScenarioExecution((first,), ())
    conversation_id = getattr(created.value, "id", "")
    if not isinstance(conversation_id, str) or not conversation_id:
        return ScenarioExecution((first,), ())
    initial = session.stream(lambda client: client.responses.create(model=model, input=f"Remember {secret}; reply only ACK.", conversation=conversation_id, stream=True))
    follow = session.stream(lambda client: client.responses.create(model=model, input="Reply only with the remembered secret.", conversation=conversation_id, stream=True))
    return ScenarioExecution((first, _operation("conversation first turn", initial), _operation("conversation two-turn recall", follow, lambda response: response.output_text.strip() == secret)), (conversation_id,))


def _retrieve(session: CaptureSession, model: str, stream: bool = True) -> ScenarioExecution:
    marker = _secret("INPUT_ITEMS")
    created = (_create(session, model, f"Reply only ACK. Marker: {marker}", store=True) if stream else session.call(lambda client: client.responses.create(model=model, input=f"Reply only ACK. Marker: {marker}", store=True, stream=False), validate_response=True))
    first = _operation("create retrievable response", created, lambda value: value.store is True and value.output_text.strip() == "ACK")
    if created.value is None:
        return ScenarioExecution((first,), ())
    response_id = created.value.id
    retrieved = session.call(lambda client: client.responses.retrieve(response_id), validate_response=True)
    items = session.call(lambda client: client.responses.input_items.list(response_id))
    deleted = session.call(lambda client: client.responses.delete(response_id))
    return ScenarioExecution((first, _operation("retrieve response", retrieved, lambda value: value.id == response_id and value.output_text.strip() == "ACK"), _operation("list input items", items, lambda value: any(marker in item.model_dump_json() for item in value.data)), _operation("cleanup stored response", deleted)), (response_id,))


def _delete(session: CaptureSession, model: str) -> ScenarioExecution:
    created = _create(session, model, "Reply only ACK.", store=True)
    first = _operation("create deletable response", created)
    if created.value is None:
        return ScenarioExecution((first,), ())
    response_id = created.value.id
    deleted = session.call(lambda client: client.responses.delete(response_id))
    readback = session.call(lambda client: client.responses.retrieve(response_id), validate_response=True)
    marker = _delete_marker(deleted.report.response_body, response_id)
    deletion_effect = deleted.report.technical_passed if marker is None else marker and deleted.report.technical_passed
    return ScenarioExecution((first, Operation("delete response", deleted.report, deletion_effect), Operation("retrieve deleted response", readback.report, readback.report.response_status == 404)), (response_id,))


def _delete_marker(body: str | None, response_id: str) -> bool | None:
    if body is None or not body.strip():
        return None
    try:
        payload = JSON_VALUE.validate_json(body)
    except JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    deleted = payload.get("deleted")
    if deleted is False:
        return False
    return payload.get("id") == response_id and payload.get("object") == "response.deleted" and deleted is True


def _background_cancel(session: CaptureSession, model: str) -> ScenarioExecution:
    created = session.call(lambda client: client.responses.create(model=model, input="Count from 1 to 100000 one number per line.", background=True, store=True, stream=False), validate_response=True)
    first = _operation("create background response", created, lambda response: response.status in {"queued", "in_progress"})
    if created.value is None:
        return ScenarioExecution((first,), ())
    background_response = created.value
    cancelled = session.call(lambda client: client.responses.cancel(background_response.id), validate_response=True)
    readback = session.call(lambda client: client.responses.retrieve(background_response.id), validate_response=True)
    return ScenarioExecution((first, _operation("cancel background response", cancelled, lambda response: response.status in {"cancelling", "cancelled"}), _operation("retrieve cancelled response", readback, lambda response: response.status == "cancelled")), (background_response.id,))


def _input_tokens(session: CaptureSession, model: str) -> ScenarioExecution:
    counted = session.call(lambda client: client.responses.input_tokens.count(model=model, input="Count these input tokens."))
    return ScenarioExecution((_operation("count input tokens", counted, lambda value: isinstance(getattr(value, "input_tokens", None), int) and not isinstance(getattr(value, "input_tokens", None), bool) and getattr(value, "input_tokens") >= 0),), ())


def _compact(session: CaptureSession, model: str) -> ScenarioExecution:
    secret = _secret("COMPACT")
    source_input: ResponseInputParam = RESPONSE_INPUT.validate_python(
        [{"role": "user", "content": f"Remember {secret}; reply only ACK."}]
    )
    compacted = session.call(lambda client: client.responses.compact(model=model, input=source_input))
    second = _operation("compact response", compacted, lambda value: value.object == "response.compaction" and any(item.type == "compaction" and bool(item.encrypted_content) for item in value.output))
    if compacted.value is None:
        return ScenarioExecution((second,), ())
    replay_input: ResponseInputParam = RESPONSE_INPUT.validate_python(
        [
            *(item.model_dump(mode="json", exclude_none=True) for item in compacted.value.output),
            {"role": "user", "content": "Reply only with the remembered secret."},
        ]
    )
    follow = session.stream(lambda client: client.responses.create(model=model, input=replay_input, instructions="Follow the user instruction exactly.", store=False, stream=True))
    return ScenarioExecution((second, _operation("reuse compact output", follow, lambda response: response.output_text.strip() == secret)), (compacted.value.id,))


def execute(session: CaptureSession, scenario: Scenario, model: str) -> ScenarioExecution:
    match scenario:
        case "previous-response":
            return _previous_response(session, model)
        case "conversation":
            return _conversation(session, model)
        case "retrieve":
            return _retrieve(session, model)
        case "store-json":
            return _retrieve(session, model, stream=False)
        case "delete":
            return _delete(session, model)
        case "background-cancel":
            return _background_cancel(session, model)
        case "input-tokens":
            return _input_tokens(session, model)
        case "compact":
            return _compact(session, model)
