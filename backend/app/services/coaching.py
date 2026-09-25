"""Retrieval-backed coaching service with Bedrock and local implementations."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CoachingMemory
from app.integrations.bedrock import BedrockCoachAdapter
from app.schemas import CoachCitation, CoachResponse


def local_coach_answer(question: str, memories: Sequence[CoachingMemory]) -> str:
    """Useful, deterministic coaching when no cloud model has been configured."""

    if not memories:
        return (
            "Start with three controlled bodyweight reps in clear camera view. "
            "I’ll use your first completed set to personalize the next cue."
        )
    latest = memories[0].content
    lower_question = question.lower()
    if "depth" in lower_question:
        focus = (
            "Use the latest rep note as your guide: keep your heels grounded "
            "and sit only as low as you can control."
        )
    elif "knee" in lower_question or "valgus" in lower_question:
        focus = (
            "Set your stance, then let your knees travel in the same direction "
            "as your toes on the way down and up."
        )
    elif "tempo" in lower_question or "fast" in lower_question:
        focus = "Try a smooth two-count descent and a controlled ascent instead of chasing speed."
    else:
        focus = "Choose one cue for the next set rather than correcting everything at once."
    return f"{focus} Your latest stored signal was: {latest}"


async def retrieve_memories(
    db: AsyncSession, user_id: str, question: str, limit: int = 4
) -> list[CoachingMemory]:
    adapter = BedrockCoachAdapter()
    embedding = await asyncio.to_thread(adapter.embed, question)
    if embedding is not None:
        statement = (
            select(CoachingMemory)
            .where(CoachingMemory.user_id == user_id, CoachingMemory.embedding.is_not(None))
            .order_by(CoachingMemory.embedding.cosine_distance(embedding))
            .limit(limit)
        )
        matches = list((await db.execute(statement)).scalars())
        if matches:
            return matches

    # Graceful local retrieval: match meaningful question tokens, then fall back
    # to the most recent feedback so the answer remains grounded in workout data.
    tokens = [token for token in question.lower().split() if len(token) >= 4][:5]
    statement = (
        select(CoachingMemory)
        .where(CoachingMemory.user_id == user_id)
        .order_by(CoachingMemory.created_at.desc())
        .limit(max(limit * 3, 12))
    )
    memories = list((await db.execute(statement)).scalars())
    if not tokens:
        return memories[:limit]
    matching = [
        memory for memory in memories if any(token in memory.content.lower() for token in tokens)
    ]
    return (matching or memories)[:limit]


async def answer_coach_question(db: AsyncSession, user_id: str, question: str) -> CoachResponse:
    memories = await retrieve_memories(db, user_id, question)
    adapter = BedrockCoachAdapter()
    answer = await asyncio.to_thread(
        adapter.generate, question, [memory.content for memory in memories]
    )
    provider = "bedrock" if answer else "local"
    answer = answer or local_coach_answer(question, memories)
    return CoachResponse(
        answer=answer,
        provider=provider,
        citations=[
            CoachCitation(memory_id=memory.id, content=memory.content, created_at=memory.created_at)
            for memory in memories
        ],
    )
