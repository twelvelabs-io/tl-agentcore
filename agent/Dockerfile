# AgentCore Runtime container — Strands agent listening on /invocations + /ping.
# linux/arm64 only — AgentCore runs the container on Graviton hosts and
# rejects amd64 images at CreateAgentRuntime with "Architecture incompatible".

FROM --platform=linux/arm64 python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY tl_agentcore ./tl_agentcore

EXPOSE 8080

CMD ["python", "-m", "tl_agentcore.runtime"]
