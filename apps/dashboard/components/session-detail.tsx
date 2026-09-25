import { Icon } from "@/components/icon";
import { ScoreRing } from "@/components/score-ring";
import { formatExercise, formatScore, scoreForRep } from "@/lib/format";
import type { SessionDetail as SessionDetailType } from "@/lib/types";

interface SessionDetailProps {
  session: SessionDetailType | null;
}

function Metric({ label, value, unit = "", precision = 0 }: { label: string; value: number | null | undefined; unit?: string; precision?: number }) {
  return <div className="movement-metric"><span>{label}</span><strong>{value === null || value === undefined ? "—" : `${value.toFixed(precision)}${unit}`}</strong></div>;
}

export function SessionDetail({ session }: SessionDetailProps) {
  if (!session) {
    return <div className="rep-detail-empty">Choose a session to inspect its movement signals.</div>;
  }

  const weakestRep = session.reps.length > 0
    ? session.reps.reduce((lowest, rep) => (scoreForRep(rep) < scoreForRep(lowest) ? rep : lowest))
    : null;

  return (
    <section className="rep-detail" aria-labelledby="rep-detail-heading">
      <div className="rep-detail__topline">
        <div>
          <p className="eyebrow">Selected workout</p>
          <h2 id="rep-detail-heading">{formatExercise(session.exercise_slug)}</h2>
          <p className="rep-detail__subhead">{session.rep_count} tracked reps · {session.status}</p>
        </div>
        <ScoreRing score={session.average_form_score} compact />
      </div>
      {weakestRep ? (
        <>
          <div className="rep-detail__callout">
            <span className="rep-detail__callout-icon"><Icon name="target" size={18} /></span>
            <p><strong>Best opportunity: rep {weakestRep.ordinal}</strong>{weakestRep.feedback}</p>
          </div>
          <div className="movement-metrics">
            <Metric label="Depth" value={weakestRep.features.minimum_knee_angle} unit="°" />
            <Metric label="Torso lean" value={weakestRep.features.maximum_torso_lean} unit="°" />
            <Metric label="Descent" value={weakestRep.features.eccentric_duration_ms / 1000} unit="s" precision={1} />
            <Metric label="Tracking" value={weakestRep.features.maximum_knee_valgus} unit="°" />
          </div>
        </>
      ) : <p className="rep-detail__waiting">Analysis will appear here after your first rep syncs.</p>}
      <div className="rep-quality-strip" aria-label="Rep quality scores">
        {session.reps.map((rep) => {
          const score = scoreForRep(rep);
          return <div className={`rep-quality-strip__bar ${score < 80 ? "rep-quality-strip__bar--attention" : ""}`} key={rep.id} style={{ height: `${Math.max(20, score)}%` }} title={`Rep ${rep.ordinal}: ${formatScore(score)}`}><span>{rep.ordinal}</span></div>;
        })}
      </div>
      <div className="rep-detail__legend"><span><i className="legend-dot legend-dot--mint" /> strong form</span><span><i className="legend-dot legend-dot--coral" /> review cue</span></div>
    </section>
  );
}
