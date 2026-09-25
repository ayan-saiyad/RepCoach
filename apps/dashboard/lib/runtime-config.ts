/** Public runtime configuration supplied by the dashboard server.

 * OAuth and upstream API details intentionally remain server-only. The
 * browser talks to the same-origin dashboard BFF, which owns bearer tokens.
 */
export interface RuntimeConfig {
  demoMode: boolean;
  demoUserId: string;
  authenticationEnabled: boolean;
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.demoMode === "boolean" &&
    typeof config.demoUserId === "string" &&
    typeof config.authenticationEnabled === "boolean"
  );
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetch("/api/runtime-config", { cache: "no-store" });
  } catch {
    throw new RuntimeConfigError("Could not load the dashboard runtime configuration.");
  }
  if (!response.ok) {
    throw new RuntimeConfigError("Could not load the dashboard runtime configuration.");
  }
  const payload: unknown = await response.json();
  if (!isRuntimeConfig(payload)) {
    throw new RuntimeConfigError("The dashboard runtime configuration is invalid.");
  }
  return payload;
}

export function runtimeConfigIsReady(config: RuntimeConfig): boolean {
  return config.demoMode || config.authenticationEnabled;
}
