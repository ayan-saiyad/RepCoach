import { formatShortDate } from "@/lib/format";
import type { TrendPoint } from "@/lib/types";

interface FormTrendChartProps {
  points: TrendPoint[];
}

const WIDTH = 640;
const HEIGHT = 244;
const PADDING = { top: 20, right: 18, bottom: 42, left: 34 };
const MIN_SCORE = 60;
const MAX_SCORE = 100;

export function FormTrendChart({ points }: FormTrendChartProps) {
  if (points.length === 0) {
    return <div className="chart-empty">Complete a few reps to unlock your form trend.</div>;
  }

  const usableWidth = WIDTH - PADDING.left - PADDING.right;
  const usableHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const xFor = (index: number) => PADDING.left + (points.length === 1 ? usableWidth / 2 : (index / (points.length - 1)) * usableWidth);
  const yFor = (score: number) => PADDING.top + ((MAX_SCORE - Math.max(MIN_SCORE, Math.min(MAX_SCORE, score))) / (MAX_SCORE - MIN_SCORE)) * usableHeight;
  const polyline = points.map((point, index) => `${xFor(index)},${yFor(point.average_score)}`).join(" ");
  const area = `${PADDING.left},${HEIGHT - PADDING.bottom} ${polyline} ${xFor(points.length - 1)},${HEIGHT - PADDING.bottom}`;
  const ticks = [100, 85, 70];

  return (
    <div className="trend-chart" role="img" aria-label="Average form score over recent training days">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="form-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#7BF1C5" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#7BF1C5" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="trend-chart__grid" x1={PADDING.left} x2={WIDTH - PADDING.right} y1={yFor(tick)} y2={yFor(tick)} />
            <text className="trend-chart__axis-label" x="0" y={yFor(tick) + 4}>{tick}</text>
          </g>
        ))}
        <polygon className="trend-chart__area" points={area} fill="url(#form-area)" />
        <polyline className="trend-chart__line" points={polyline} fill="none" />
        {points.map((point, index) => (
          <g key={`${point.date}-${index}`} className="trend-chart__point-group">
            <title>{`${formatShortDate(point.date)}: ${Math.round(point.average_score)} average across ${point.reps} reps`}</title>
            <circle className="trend-chart__point-halo" cx={xFor(index)} cy={yFor(point.average_score)} r="8" />
            <circle className="trend-chart__point" cx={xFor(index)} cy={yFor(point.average_score)} r="4" />
            <text className="trend-chart__x-label" x={xFor(index)} y={HEIGHT - 12} textAnchor="middle">{formatShortDate(point.date)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
