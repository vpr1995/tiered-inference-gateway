#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] starting vLLM server for ${MODEL_ID}"
python3 -m vllm.entrypoints.openai.api_server \
  --model "${MODEL_ID}" \
  --port "${VLLM_PORT}" \
  --gpu-memory-utilization 0.90 \
  --max-model-len "${MAX_MODEL_LEN:-4096}" \
  --disable-log-requests &
VLLM_PID=$!

echo "[entrypoint] waiting for vLLM to become healthy..."
until curl -sf "http://localhost:${VLLM_PORT}/health" > /dev/null; do
  if ! kill -0 "${VLLM_PID}" 2>/dev/null; then
    echo "[entrypoint] vLLM server process died during startup" >&2
    exit 1
  fi
  sleep 5
done
echo "[entrypoint] vLLM is healthy, starting SQS worker"

python3 worker.py &
WORKER_PID=$!

# If either process exits, tear down the task so ECS replaces it.
wait -n "${VLLM_PID}" "${WORKER_PID}"
exit $?
