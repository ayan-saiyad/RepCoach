FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
COPY app ./app
COPY worker ./worker
COPY ml ./ml
COPY migrations ./migrations
COPY alembic.ini ./
COPY entrypoint.sh ./
# Fargate tasks run CPU inference. Installing PyTorch from the CPU wheel index
# avoids downloading CUDA runtimes that cannot be used in this image.
RUN pip install ".[integrations]" \
    && pip install --index-url https://download.pytorch.org/whl/cpu "torch>=2.4,<3" \
    && addgroup --system repcoach \
    && adduser --system --ingroup repcoach --home /app repcoach \
    && chmod +x /app/entrypoint.sh \
    && chown -R repcoach:repcoach /app

EXPOSE 8000
USER repcoach
ENTRYPOINT ["./entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
