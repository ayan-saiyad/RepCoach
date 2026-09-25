export const colors = {
  canvas: "#08110F",
  canvasElevated: "#0D1A16",
  surface: "#11231E",
  surfaceRaised: "#173128",
  surfaceMuted: "#1C3930",
  border: "#2B5145",
  borderSubtle: "#1B332C",
  text: "#F2F8F4",
  textMuted: "#A7BDB4",
  textFaint: "#6E887D",
  lime: "#C8FF65",
  limeDeep: "#8FCB36",
  mint: "#79E5C0",
  orange: "#FFB45E",
  coral: "#FF7B6B",
  blue: "#79B8FF",
  black: "#030807",
  white: "#FFFFFF",
} as const;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 28,
  xxl: 36,
} as const;

export const radii = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 30,
  pill: 999,
} as const;

export function scoreColor(score: number): string {
  if (score >= 90) return colors.lime;
  if (score >= 75) return colors.mint;
  if (score >= 60) return colors.orange;
  return colors.coral;
}

export function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return colors.mint;
  if (confidence >= 0.6) return colors.orange;
  return colors.coral;
}
