#!/usr/bin/env python3
"""
Sample real-time inference client.

Connects to the WebSocket API, sends one inference request, and prints
tokens as they stream back live - no S3 polling, no result files.

Usage:
    pip install websockets
    python3 test/client_test.py wss://<api-id>.execute-api.<region>.amazonaws.com/prod \\
        --prompt "Explain the CAP theorem in two sentences." \\
        --max-tokens 200

Force a specific tier for testing the routing logic explicitly:
    python3 test/client_test.py <ws-url> --prompt "..." --route large
"""
import argparse
import asyncio
import json
import sys
import time

import websockets


async def run(ws_url: str, prompt: str, max_tokens: int, temperature: float, top_p: float, route: str | None):
    async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20) as ws:
        request = {"prompt": prompt, "maxTokens": max_tokens, "temperature": temperature, "topP": top_p}
        if route:
            request["route"] = route

        start = time.monotonic()
        await ws.send(json.dumps(request))

        request_id = None
        tier = None
        token_count = 0

        async for raw in ws:
            msg = json.loads(raw)
            msg_type = msg.get("type")

            if msg_type == "queued":
                request_id, tier = msg["requestId"], msg["tier"]
                print(f"[queued] requestId={request_id} tier={tier}", file=sys.stderr)

            elif msg_type == "token":
                print(msg["token"], end="", flush=True)
                token_count += 1

            elif msg_type == "done":
                elapsed = time.monotonic() - start
                print(f"\n\n[done] tier={tier} tokens~={token_count} elapsed={elapsed:.2f}s", file=sys.stderr)
                return

            elif msg_type == "error":
                print(f"\n[error] {msg.get('error')} {msg.get('detail', '')}", file=sys.stderr)
                return

            else:
                print(f"\n[unknown message] {msg}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Streaming test client for the inference WebSocket API")
    parser.add_argument("ws_url", help="wss://<api-id>.execute-api.<region>.amazonaws.com/<stage>")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--top-p", type=float, default=1.0)
    parser.add_argument("--route", choices=["small", "medium", "large"], default=None,
                         help="Force a tier instead of letting the router classify the prompt")
    args = parser.parse_args()

    asyncio.run(run(args.ws_url, args.prompt, args.max_tokens, args.temperature, args.top_p, args.route))


if __name__ == "__main__":
    main()
