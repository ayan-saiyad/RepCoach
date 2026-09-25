import type { Rep, WorkoutSession } from "@/lib/types";

const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const timeFormatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function formatExercise(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatShortDate(value: string): string {
  if (!value) return "—";
  // A date-only string is parsed as UTC by browsers; anchoring it at noon avoids an off-by-one display.
  const normalized = value.length === 10 ? `${value}T12:00:00` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

export function formatSessionTime(value: string | null): string {
  if (!value) return "In progress";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : `${dateFormatter.format(date)} · ${timeFormatter.format(date)}`;
}

export function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : Math.round(value).toString();
}

export function scoreForRep(rep: Rep): number {
  return rep.final_score ?? rep.preliminary_score;
}

export function scoreDescriptor(score: number | null | undefined): string {
  if (score === null || score === undefined) return "Not scored";
  if (score >= 92) return "Excellent";
  if (score >= 85) return "Strong";
  if (score >= 75) return "Building";
  return "Needs focus";
}

export function sessionRepLabel(session: WorkoutSession): string {
  const target = session.target_reps > 0 ? ` / ${session.target_reps}` : "";
  return `${session.rep_count}${target} reps`;
}
