"""AWS Bedrock generation and embedding adapter with a local-safe fallback."""

from __future__ import annotations

import json
import logging
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.core.config import get_settings

logger = logging.getLogger(__name__)


class BedrockCoachAdapter:
    """Use Bedrock Converse when configured; callers own deterministic fallback text."""

    def __init__(self) -> None:
        self.settings = get_settings()

    @property
    def is_configured(self) -> bool:
        return bool(self.settings.bedrock_model_id)

    def generate(self, question: str, context: list[str]) -> str | None:
        if not self.is_configured:
            return None
        system = (
            "You are RepCoach, a supportive strength-training coach. Use only the supplied "
            "workout context, be concise, avoid medical claims, and tell the athlete to stop "
            "if they feel pain. Do not invent measurements."
        )
        prompt = "Workout context:\n- " + "\n- ".join(context or ["No prior rep notes available."])
        prompt += f"\n\nAthlete question: {question}"
        try:
            client = boto3.client("bedrock-runtime", region_name=self.settings.bedrock_region)
            response: dict[str, Any] = client.converse(
                modelId=self.settings.bedrock_model_id,
                system=[{"text": system}],
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={"maxTokens": 240, "temperature": 0.35},
            )
            return str(response["output"]["message"]["content"][0]["text"]).strip()
        except (BotoCoreError, ClientError, KeyError, IndexError, TypeError) as error:
            logger.warning("Bedrock generation unavailable; using local coach: %s", error)
            return None

    def embed(self, text: str) -> list[float] | None:
        """Return a configured embedding vector, or None for lexical retrieval.

        The database column is 1536-dimensional. Configure a compatible Bedrock
        embedding model before enabling this path; the length check prevents a
        mismatched model from corrupting vector retrieval.
        """

        model_id = self.settings.bedrock_embedding_model_id
        if not model_id:
            return None
        try:
            client = boto3.client("bedrock-runtime", region_name=self.settings.bedrock_region)
            response = client.invoke_model(
                modelId=model_id,
                body=json.dumps({"inputText": text}),
                contentType="application/json",
                accept="application/json",
            )
            payload = json.loads(response["body"].read())
            embedding = payload.get("embedding")
            if not isinstance(embedding, list) or len(embedding) != 1536:
                logger.warning(
                    "Bedrock embedding dimension is not compatible with the "
                    "configured pgvector column"
                )
                return None
            return [float(value) for value in embedding]
        except (BotoCoreError, ClientError, KeyError, TypeError, ValueError) as error:
            logger.warning("Bedrock embedding unavailable; using lexical retrieval: %s", error)
            return None
