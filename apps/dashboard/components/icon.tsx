import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "activity"
  | "arrow-up-right"
  | "calendar"
  | "camera"
  | "check"
  | "chevron-right"
  | "clock"
  | "flame"
  | "info"
  | "play"
  | "refresh"
  | "sparkles"
  | "target"
  | "trend"
  | "zap";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 20, ...props }: IconProps) {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };

  const paths: Record<IconName, ReactNode> = {
    activity: <><path d="M3 12h3l2.4-7 4.2 14 2.4-7H21" /></>,
    "arrow-up-right": <><path d="M7 17 17 7" /><path d="M8 7h9v9" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
    camera: <><path d="M4 7h3l1.4-2h7.2L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" /><circle cx="12" cy="13" r="3.5" /></>,
    check: <><path d="m5 12 4.2 4.2L19 6.5" /></>,
    "chevron-right": <><path d="m9 18 6-6-6-6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    flame: <><path d="M12.4 2.5c.7 3.2-1 4.8-2.5 6.4-1 1.1-1.8 2.4-1.8 4.1a3.9 3.9 0 0 0 7.8.1c0-1.9-1.1-3.4-2.5-4.8.2 1.7-.6 2.6-1.5 3.2.1-2.5-1.2-4.3.4-9Z" /><path d="M10.4 17.9c-1.3-2.1.2-3.6 1.5-4.7 1.5 1.2 2.2 2.4 1.5 4.7" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    play: <><path d="m9 7 8 5-8 5V7Z" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.7-3.9L3 10" /><path d="M3 5v5h5" /><path d="M4 13a8 8 0 0 0 14.7 3.9L21 14" /><path d="M21 19v-5h-5" /></>,
    sparkles: <><path d="m12 3-1.4 4.6L6 9l4.6 1.4L12 15l1.4-4.6L18 9l-4.6-1.4L12 3Z" /><path d="m19 15-.7 2.3L16 18l2.3.7L19 21l.7-2.3L22 18l-2.3-.7L19 15ZM5 15l-.6 1.6L3 17l1.4.4L5 19l.6-1.6L7 17l-1.4-.4L5 15Z" /></>,
    target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="m17.7 6.3 3-3M17 4h3.7v3.7" /></>,
    trend: <><path d="M4 18 10 12l4 3 6-8" /><path d="M16 7h4v4" /></>,
    zap: <><path d="m13 2-8 12h6l-1 8 8-12h-6l1-8Z" /></>,
  };

  return <svg {...shared}>{paths[name]}</svg>;
}
