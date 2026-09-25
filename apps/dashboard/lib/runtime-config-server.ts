import "server-only";

import type { RuntimeConfig } from "@/lib/runtime-config";

const developmentEnvironments = new Set(["development", "dev", "local", "test"]);

function environmentName(): string {
  return (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
}

function isDevelopmentEnvironment(): boolean {
  return developmentEnvironments.has(environmentName());
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function permittedUrl(value: string | undefined, allowLocalHttp: boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(allowLocalHttp && url.protocol === "http:" && isLocalhost)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function originUrl(value: string | undefined, allowLocalHttp: boolean): string | null {
  const parsed = permittedUrl(value, allowLocalHttp);
  if (!parsed) return null;
  return new URL(parsed).origin;
}

function parseScopes(value: string | undefined): string[] {
  const scopes = (value ?? "openid email profile")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.includes("openid") ? scopes : ["openid", ...scopes];
}

export interface CognitoServerConfig {
  hostedUiUrl: string;
  clientId: string;
  redirectUri: string;
  logoutUri: string;
  scopes: string[];
}

export interface DashboardServerConfig {
  apiBaseUrl: string;
  dashboardOrigin: string;
  demoMode: boolean;
  demoUserId: string;
  secureCookies: boolean;
  cognito: CognitoServerConfig | null;
}

function cognitoConfig(allowLocalHttp: boolean): CognitoServerConfig | null {
  const hostedUiUrl = originUrl(
    process.env.COGNITO_HOSTED_UI_DOMAIN ?? process.env.COGNITO_DOMAIN,
    allowLocalHttp,
  );
  const clientId = (process.env.COGNITO_APP_CLIENT_ID ?? process.env.COGNITO_CLIENT_ID)?.trim();
  const redirectUri = permittedUrl(process.env.COGNITO_REDIRECT_URI, allowLocalHttp);
  const logoutUri = permittedUrl(process.env.COGNITO_LOGOUT_URI, allowLocalHttp);
  if (!hostedUiUrl || !clientId || !redirectUri || !logoutUri) return null;
  return {
    hostedUiUrl,
    clientId,
    redirectUri,
    logoutUri,
    scopes: parseScopes(process.env.COGNITO_SCOPES),
  };
}

/**
 * Resolve configuration at request time so a single dashboard image can be
 * promoted between environments without rebuilding public JavaScript bundles.
 */
export function getServerRuntimeConfig(): DashboardServerConfig {
  const isDevelopment = isDevelopmentEnvironment();
  const demoMode = isDevelopment && parseBoolean(process.env.DASHBOARD_DEMO_MODE, true);
  const apiBaseUrl = originUrl(
    process.env.DASHBOARD_API_BASE_URL ??
      process.env.REPCOACH_API_BASE_URL ??
      process.env.NEXT_PUBLIC_API_BASE_URL ??
      (isDevelopment ? "http://localhost:8000" : undefined),
    isDevelopment,
  );
  const redirectUri = permittedUrl(process.env.COGNITO_REDIRECT_URI, isDevelopment);
  const dashboardOrigin = originUrl(
    process.env.DASHBOARD_ORIGIN ?? redirectUri ?? (isDevelopment ? "http://localhost:3000" : undefined),
    isDevelopment,
  );
  return {
    apiBaseUrl: apiBaseUrl ?? "",
    dashboardOrigin: dashboardOrigin ?? "",
    demoMode,
    demoUserId: process.env.DASHBOARD_DEMO_USER_ID?.trim() || "demo-athlete",
    secureCookies: !isDevelopment,
    cognito: cognitoConfig(isDevelopment),
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  const config = getServerRuntimeConfig();
  return {
    demoMode: config.demoMode,
    demoUserId: config.demoUserId,
    authenticationEnabled: Boolean(config.apiBaseUrl && config.cognito && config.dashboardOrigin),
  };
}

export function getRequiredCognitoConfig(): CognitoServerConfig {
  const config = getServerRuntimeConfig();
  if (config.demoMode || !config.cognito) {
    throw new Error("Cognito authentication is not configured for this dashboard runtime.");
  }
  return config.cognito;
}

export function getRequiredServerConfig(): DashboardServerConfig {
  const config = getServerRuntimeConfig();
  if (!config.apiBaseUrl || !config.dashboardOrigin || (!config.demoMode && !config.cognito)) {
    throw new Error("Dashboard server runtime is not configured.");
  }
  return config;
}
