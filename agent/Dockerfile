# AgentCore Runtime container — Strands agent listening on /invocations + /ping.
# linux/arm64 only — AgentCore runs the container on Graviton hosts and
# rejects amd64 images at CreateAgentRuntime with "Architecture incompatible".
#
# Wheels are pre-downloaded by the operator on the host (not inside docker)
# via `pip3 download --platform manylinux2014_aarch64 --only-binary :all:
# --dest wheels/ -r requirements.txt`. We install offline so the slow,
# corruption-prone arm64-emulated network never has to fetch a wheel —
# cuts the build from ~35 min (often failing on hash mismatches) to ~3 min.

FROM --platform=linux/arm64 python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
COPY wheels /wheels
RUN pip install --no-index --find-links=/wheels -r requirements.txt \
 && rm -rf /wheels

COPY tl_agentcore ./tl_agentcore

# Drop root before the process runs. AgentCore doesn't require root
# and the container talks only to STDOUT + a single HTTP port — no
# host mounts, no privileged syscalls. Fixed uid/gid so build layers
# (`chown ...`) are cache-stable across rebuilds.
RUN groupadd --system --gid 1001 agent \
 && useradd  --system --uid 1001 --gid 1001 --create-home --home-dir /home/agent agent \
 && chown -R agent:agent /app
USER agent

EXPOSE 8080

CMD ["python", "-m", "tl_agentcore.runtime"]
