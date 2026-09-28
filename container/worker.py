#!/usr/bin/env python3
"""
SQS -> vLLM -> WebSocket bridge.

Polls this tier's SQS queue, forwards each request to the local vLLM
OpenAI-compatible server with streaming enabled, and pushes every generated
token straight back to the originating client over API Gateway
Management API (PostToConnection) as it is produced.

Nothing is written to S3. The only persisted state is a short-TTL row in
the "requests" DynamoDB table used to detect duplicate delivery and to
notice a client that disconnected mid-generation, so we can stop generating
(and stop burning GPU time) as soon as that happens.
"""
import asyncio
import json
import logging
import os
import time
from typing import Any, Optional

import boto3
import httpx
from botocore.config import Config
from botocore.exceptions import ClientError

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("worker")

MODEL_ID = os.environ["MODEL_ID"]
TIER_NAME = os.environ["TIER_NAME"]
QUEUE_URL = os.environ["QUEUE_URL"]
REQUESTS_TABLE = os.environ["REQUESTS_TABLE"]
CONNECTIONS_TABLE = os.environ["CONNECTIONS_TABLE"]
VLLM_BASE_URL = f"http://localhost:{os.environ.get('VLLM_PORT', '8000')}"

MAX_MESSAGES_PER_POLL = int(os.environ.get("MAX_MESSAGES_PER_POLL", "5"))
POLL_WAIT_SECONDS = 20  # SQS long polling

boto_config = Config(retries={"max_attempts": 3, "mode": "adaptive"})
sqs = boto3.client("sqs", config=boto_config)
dynamodb = boto3.resource("dynamodb", config=boto_config)
requests_table = dynamodb.Table(REQUESTS_TABLE)
connections_table = dynamodb.Table(CONNECTIONS_TABLE)

# One ApiGatewayManagementApi client per endpoint (the WebSocket API's
# domain/stage is constant for this deployment, but building a fresh client
# per endpoint value keeps this correct if that ever changes).
_apigw_clients: dict[str, Any] = {}


def apigw_client(endpoint: str):
    if endpoint not in _apigw_clients:
        _apigw_clients[endpoint] = boto3.client(
            "apigatewaymanagementapi", endpoint_url=endpoint, config=boto_config
        )
    return _apigw_clients[endpoint]


class ClientGone(Exception):
    """Raised when PostToConnection reports the client disconnected."""


def post_to_connection(endpoint: str, connection_id: str, payload: dict) -> None:
    try:
        apigw_client(endpoint).post_to_connection(
            ConnectionId=connection_id, Data=json.dumps(payload).encode("utf-8")
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "GoneException":
            raise ClientGone() from e
        raise


def connection_is_live(connection_id: str) -> bool:
    resp = connections_table.get_item(Key={"connectionId": connection_id})
    return "Item" in resp


def mark_request(request_id: str, **fields) -> None:
    expr_names = {f"#{k}": k for k in fields}
    expr_values = {f":{k}": v for k, v in fields.items()}
    requests_table.update_item(
        Key={"requestId": request_id},
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )


def get_request_status(request_id: str) -> Optional[str]:
    resp = requests_table.get_item(Key={"requestId": request_id}, ProjectionExpression="#s",
                                    ExpressionAttributeNames={"#s": "status"})
    item = resp.get("Item")
    return item.get("status") if item else None


async def stream_completion(prompt: str, max_tokens: int, temperature: float, top_p: float):
    """Yields (token_text, finished) tuples from vLLM's streaming chat completions endpoint."""
    payload = {
        "model": MODEL_ID,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)) as client:
        async with client.stream("POST", f"{VLLM_BASE_URL}/v1/chat/completions", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    return
                chunk = json.loads(data)
                delta = chunk["choices"][0].get("delta", {})
                token = delta.get("content")
                if token:
                    yield token


async def handle_message(message: dict) -> bool:
    """Returns True if the SQS message should be deleted (ack'd)."""
    receipt_handle = message["ReceiptHandle"]
    try:
        body = json.loads(message["Body"])
    except json.JSONDecodeError:
        log.error("malformed message body, deleting: %s", message.get("MessageId"))
        return True  # can never succeed - drop it rather than retry into the DLQ forever

    request_id = body["requestId"]
    connection_id = body["connectionId"]
    endpoint = body["apiGatewayEndpoint"]

    existing_status = get_request_status(request_id)
    if existing_status == "done":
        log.info("request %s already completed, skipping redelivery", request_id)
        return True

    if not connection_is_live(connection_id):
        log.info("client for request %s disconnected before processing started", request_id)
        mark_request(request_id, status="abandoned")
        return True

    mark_request(request_id, status="processing", tier=TIER_NAME, startedAt=int(time.time()))

    try:
        async for token in stream_completion(
            body["prompt"], body.get("maxTokens", 512), body.get("temperature", 0.7), body.get("topP", 1.0)
        ):
            try:
                post_to_connection(endpoint, connection_id, {
                    "type": "token", "requestId": request_id, "tier": TIER_NAME, "token": token,
                })
            except ClientGone:
                log.info("client for request %s disconnected mid-stream, stopping early", request_id)
                mark_request(request_id, status="abandoned")
                return True

        post_to_connection(endpoint, connection_id, {"type": "done", "requestId": request_id, "tier": TIER_NAME})
        mark_request(request_id, status="done", finishedAt=int(time.time()))
        return True

    except ClientGone:
        mark_request(request_id, status="abandoned")
        return True
    except httpx.HTTPStatusError as e:
        # vLLM rejected the request (e.g. bad params) - this will never
        # succeed on retry, so tell the client and drop the message.
        log.warning("vLLM rejected request %s: %s", request_id, e)
        try:
            post_to_connection(endpoint, connection_id, {
                "type": "error", "requestId": request_id, "error": "inference request rejected",
            })
        except ClientGone:
            pass
        mark_request(request_id, status="failed")
        return True
    except Exception:
        # Transient failure (network blip, vLLM temporarily overloaded, etc).
        # Leave the message in-flight so SQS redelivers it after the
        # visibility timeout, up to the queue's maxReceiveCount before DLQ.
        log.exception("transient failure processing request %s, will retry", request_id)
        return False


async def poll_loop():
    log.info("worker started for tier=%s model=%s queue=%s", TIER_NAME, MODEL_ID, QUEUE_URL)
    while True:
        resp = sqs.receive_message(
            QueueUrl=QUEUE_URL,
            MaxNumberOfMessages=MAX_MESSAGES_PER_POLL,
            WaitTimeSeconds=POLL_WAIT_SECONDS,
        )
        messages = resp.get("Messages", [])
        if not messages:
            continue

        results = await asyncio.gather(*(handle_message(m) for m in messages))
        for message, should_delete in zip(messages, results):
            if should_delete:
                sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=message["ReceiptHandle"])


if __name__ == "__main__":
    asyncio.run(poll_loop())
