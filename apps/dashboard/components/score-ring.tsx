import { scoreDescriptor } from "@/lib/format";

interface ScoreRingProps {
  score: number | null | undefined;
  compact?: boolean;
}

export function ScoreRing({ score, compact = false }: ScoreRingProps) {
  const safeScore = Math.max(0, Math.min(100, score ?? 0));
  const radius = compact ? 31 : 49;
  const stroke = compact ? 6 : 8;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - safeScore / 100);
  const dimension = compact ? 82 : 126;
  const centre = dimension / 2;

  return (
    <div className={`score-ring ${compact ? "score-ring--compact" : ""}`} aria-label={`Form score ${Math.round(safeScore)} out of 100`}>
      <svg width={dimension} height={dimension} viewBox={`0 0 ${dimension} ${dimension}`} aria-hidden="true">
        <circle className="score-ring__track" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={stroke} />
        <circle
          className="score-ring__progress"
          cx={centre}
          cy={centre}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${centre} ${centre})`}
        />
      </svg>
      <span className="score-ring__content"><strong>{score === null || score === undefined ? "—" : Math.round(safeScore)}</strong>{compact ? null : <small>{scoreDescriptor(score)}</small>}</span>
    </div>
  );
}
