import { Icon } from "@/components/icon";
import { formatExercise, formatScore, formatSessionTime, sessionRepLabel } from "@/lib/format";
import type { WorkoutSession } from "@/lib/types";

interface SessionListProps {
  sessions: WorkoutSession[];
  activeSessionId?: string | null;
  onSelect: (sessionId: string) => void;
}

export function SessionList({ sessions, activeSessionId, onSelect }: SessionListProps) {
  if (sessions.length === 0) {
    return <div className="sessions-empty">Your completed sets will show up here.</div>;
  }

  return (
    <div className="session-list">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <button
            className={`session-row ${isActive ? "session-row--active" : ""}`}
            key={session.id}
            onClick={() => onSelect(session.id)}
            type="button"
          >
            <span className="session-row__exercise-icon"><Icon name={session.exercise_slug.includes("squat") ? "activity" : "target"} size={18} /></span>
            <span className="session-row__main">
              <strong>{formatExercise(session.exercise_slug)}</strong>
              <small>{formatSessionTime(session.completed_at ?? session.started_at)}</small>
            </span>
            <span className="session-row__reps">{sessionRepLabel(session)}</span>
            <span className={`session-row__score ${session.average_form_score !== null && session.average_form_score < 80 ? "session-row__score--attention" : ""}`}>
              <strong>{formatScore(session.average_form_score)}</strong><small>form</small>
            </span>
            <Icon name="chevron-right" size={17} className="session-row__chevron" />
          </button>
        );
      })}
    </div>
  );
}
