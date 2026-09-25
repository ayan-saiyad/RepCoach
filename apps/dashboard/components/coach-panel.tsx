"use client";

import { useState } from "react";

import { Icon } from "@/components/icon";
import { askCoach } from "@/lib/api";
import type { CoachCitation } from "@/lib/types";

interface CoachPanelProps {
  cue: string | null;
  score: number | null | undefined;
}

const prompts = ["How can I improve my squat depth?", "What should I focus on next set?"];

export function CoachPanel({ cue, score }: CoachPanelProps) {
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [citations, setCitations] = useState<CoachCitation[]>([]);
  const [provider, setProvider] = useState<"bedrock" | "local" | "dashboard">("dashboard");
  const [isThinking, setIsThinking] = useState(false);

  const fallbackResponse = (value: string) => {
    const normalised = value.toLowerCase();
    const scoreNote = score !== null && score !== undefined && score >= 85
      ? "Your overall movement quality is already strong, so make one small change rather than overcorrecting."
      : "Keep the next set controlled and use the feedback on your lowest-scoring rep as your single cue.";
    const depthNote = cue ?? "Aim for a calm, controlled descent and keep your knees tracking over your toes.";
    setResponse(normalised.includes("depth") ? `${depthNote} ${scoreNote}` : `${scoreNote} Today’s priority: ${depthNote}`);
    setCitations([]);
    setProvider("dashboard");
  };

  const respond = async (value: string) => {
    setIsThinking(true);
    try {
      const reply = await askCoach(value);
      setResponse(reply.answer);
      setCitations(reply.citations);
      setProvider(reply.provider);
    } catch {
      fallbackResponse(value);
    } finally {
      setIsThinking(false);
    }
    setQuestion("");
  };

  return (
    <section className="coach-panel" aria-labelledby="coach-heading">
      <div className="coach-panel__orb"><Icon name="sparkles" size={19} /></div>
      <div className="coach-panel__header">
        <p className="eyebrow">RepCoach intelligence</p>
        <h2 id="coach-heading">Ask your coach</h2>
      </div>
      <p className="coach-panel__lead">Your next best adjustment is based on your recent rep data—not a generic workout plan.</p>
      <div className="coach-panel__insight">
        <span><Icon name="zap" size={15} /></span>
        <p><strong>Focus cue</strong>{cue ?? "Keep your tempo smooth and your alignment steady."}</p>
      </div>
      {response ? <div className="coach-panel__response" role="status"><Icon name="sparkles" size={16} /><div><p>{response}</p><small>{provider === "bedrock" ? "Bedrock coach · grounded in saved rep feedback" : provider === "local" ? "Local retrieval coach · grounded in saved rep feedback" : "Dashboard fallback · connect the API for retrieval coaching"}</small>{citations.length > 0 ? <span className="coach-panel__citations">Based on {citations.length} recent rep signal{citations.length === 1 ? "" : "s"}.</span> : null}</div></div> : null}
      <div className="coach-panel__prompts" aria-label="Suggested questions">
        {prompts.map((prompt) => <button key={prompt} type="button" onClick={() => void respond(prompt)} disabled={isThinking}>{prompt}</button>)}
      </div>
      <form className="coach-panel__form" onSubmit={(event) => { event.preventDefault(); if (question.trim()) void respond(question); }}>
        <input aria-label="Ask your coach a question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about your form…" />
        <button aria-label="Send question" type="submit" disabled={!question.trim() || isThinking}>{isThinking ? <Icon name="refresh" size={17} className="spin" /> : <Icon name="arrow-up-right" size={17} />}</button>
      </form>
      <p className="coach-panel__disclaimer"><Icon name="info" size={13} /> The server retrieves saved rep feedback first; Bedrock is optional and never sees raw video.</p>
    </section>
  );
}
