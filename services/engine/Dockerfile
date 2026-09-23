# VTrack Engine — one always-on container (CLAUDE.md §3, §7).
# Render builds this from render.yaml; CI's `docker` job builds and runs the same file with
# no network at all, which is what proves the model weights are baked in.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 \
    UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_CACHE=1 UV_PYTHON_DOWNLOADS=never

# The uv the lockfile was produced with, from PyPI: no second registry in the build.
RUN pip install uv==0.8.17 \
 && useradd --create-home --home-dir /home/app --uid 10001 app \
 && mkdir /app && chown app:app /app

# Everything from here runs as `app`. The model hubs cache weights under ~/.cache, so the
# weights must be fetched as the user that later reads them: fetched as root, they would
# sit in /root/.cache and every cold start would quietly download them again.
USER app
ENV HOME=/home/app
WORKDIR /app

# Dependencies in their own layer: they change far less often than the engine does.
COPY --chown=app:app pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY --chown=app:app vtrack_engine ./vtrack_engine
RUN uv sync --frozen --no-dev --no-editable

RUN /app/.venv/bin/python -m vtrack_engine.alpr.local_fastalpr --fetch

# ALPR_OFFLINE: a missing weight is an error on /health, never a download at the gate.
# UV_NO_SYNC and the direct CMD: nothing re-resolves or installs when the container starts.
# One thread each for BLAS/OpenMP, as for onnxruntime and OpenCV (local_fastalpr.py).
ENV HOST=0.0.0.0 PORT=10000 ALPR_OFFLINE=1 UV_NO_SYNC=1 \
    OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
    PATH=/app/.venv/bin:$PATH
EXPOSE 10000
CMD ["/app/.venv/bin/vtrack-engine"]
