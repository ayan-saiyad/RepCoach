"""Personalized coaching endpoint with citations to stored form feedback."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_database_session
from app.schemas import CoachQuestionRequest, CoachResponse
from app.services.coaching import answer_coach_question

router = APIRouter(prefix="/v1/coach", tags=["coaching"])
DbSession = Annotated[AsyncSession, Depends(get_database_session)]


@router.post("/query", response_model=CoachResponse)
async def ask_coach(request: CoachQuestionRequest, db: DbSession) -> CoachResponse:
    return await answer_coach_question(db, request.user_id, request.question)
