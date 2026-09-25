import type { IconName } from "@/components/icon";
import { Icon } from "@/components/icon";

interface MetricCardProps {
  label: string;
  value: string;
  detail: string;
  icon: IconName;
  accent: "mint" | "violet" | "amber" | "sky";
  trend?: string;
}

export function MetricCard({ label, value, detail, icon, accent, trend }: MetricCardProps) {
  return (
    <article className={`metric-card metric-card--${accent}`}>
      <div className="metric-card__topline">
        <span className="metric-card__icon"><Icon name={icon} size={18} /></span>
        {trend ? <span className="metric-card__trend"><Icon name="arrow-up-right" size={13} />{trend}</span> : null}
      </div>
      <p className="metric-card__label">{label}</p>
      <p className="metric-card__value">{value}</p>
      <p className="metric-card__detail">{detail}</p>
    </article>
  );
}
