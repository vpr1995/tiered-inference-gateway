FROM vllm/vllm-openai:v0.6.4

ARG MODEL_ID
ENV MODEL_ID=${MODEL_ID}
ENV VLLM_PORT=8000

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# vLLM's OpenAI-compatible server
EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
