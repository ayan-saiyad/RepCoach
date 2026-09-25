import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

// Finishes a custom-scheme redirect on Android and web before React renders.
// This must stay at module scope for expo-auth-session's browser bridge.
void WebBrowser.maybeCompleteAuthSession();

const TOKEN_STORAGE_KEY = "repcoach.auth.tokens.v1";
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_SCOPES = ["openid", "profile", "email"];
const isDevelopmentBuild = typeof __DEV__ !== "undefined" && __DEV__;

export interface AuthenticatedUser {
  /** Cognito's immutable subject identifier. This is what the API authorizes. */
  id: string;
  displayName: string;
  email?: string;
}

interface StoredTokens {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType?: string;
}

interface AuthConfiguration {
  clientId: string;
  domain: string;
  redirectUri: string;
  scopes: string[];
}

export interface RepCoachAuth {
  user: AuthenticatedUser | null;
  isLoading: boolean;
  isSigningIn: boolean;
  error: string | null;
  isConfigured: boolean;
  configurationError: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Resolves a fresh access token for an API request without exposing it to UI code. */
  getAccessToken(): Promise<string | null>;
}

function trimValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizeHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function configuredScopes(): string[] {
  const values = trimValue(process.env.EXPO_PUBLIC_COGNITO_SCOPES)
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const scopes = values.length > 0 ? values : DEFAULT_SCOPES;
  return scopes.includes("openid") ? scopes : ["openid", ...scopes];
}

function configuredRedirectUri(): string {
  const configured = trimValue(process.env.EXPO_PUBLIC_COGNITO_REDIRECT_URI);
  if (configured) return configured;
  return AuthSession.makeRedirectUri({ scheme: "repcoach", path: "auth/callback" });
}

function readConfiguration(): { configuration: AuthConfiguration | null; error: string | null } {
  const clientId = trimValue(process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID);
  const domain = normalizeHttpsOrigin(trimValue(process.env.EXPO_PUBLIC_COGNITO_DOMAIN));
  const redirectUri = configuredRedirectUri();

  if (!clientId) {
    return { configuration: null, error: "This build is missing EXPO_PUBLIC_COGNITO_CLIENT_ID." };
  }
  if (!domain) {
    return {
      configuration: null,
      error: "This build needs an HTTPS EXPO_PUBLIC_COGNITO_DOMAIN, such as https://your-domain.auth.us-east-1.amazoncognito.com.",
    };
  }
  try {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "repcoach:") {
      return { configuration: null, error: "EXPO_PUBLIC_COGNITO_REDIRECT_URI must use the repcoach:// custom scheme." };
    }
  } catch {
    return { configuration: null, error: "EXPO_PUBLIC_COGNITO_REDIRECT_URI is invalid." };
  }

  return {
    configuration: { clientId, domain, redirectUri, scopes: configuredScopes() },
    error: null,
  };
}

function discoveryFor(configuration: AuthConfiguration): AuthSession.DiscoveryDocument {
  return {
    authorizationEndpoint: `${configuration.domain}/oauth2/authorize`,
    tokenEndpoint: `${configuration.domain}/oauth2/token`,
    revocationEndpoint: `${configuration.domain}/oauth2/revoke`,
  };
}

function decodeJwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload || typeof globalThis.atob !== "function") return null;

  try {
    const normalized = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringClaim(claims: Record<string, unknown> | null, key: string): string | undefined {
  const value = claims?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The subject is read only to populate the session request. The API validates
 * the bearer signature and binds this submitted value to the token's `sub`.
 */
function userFromTokens(tokens: StoredTokens): AuthenticatedUser | null {
  const idClaims = decodeJwtClaims(tokens.idToken);
  const accessClaims = decodeJwtClaims(tokens.accessToken);
  const id = stringClaim(idClaims, "sub") ?? stringClaim(accessClaims, "sub");
  if (!id) return null;

  const email = stringClaim(idClaims, "email") ?? stringClaim(accessClaims, "email");
  const displayName =
    stringClaim(idClaims, "name") ??
    stringClaim(idClaims, "preferred_username") ??
    stringClaim(accessClaims, "username") ??
    email ??
    "RepCoach athlete";
  return { id, displayName, ...(email ? { email } : {}) };
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredTokens>;
  return (
    typeof candidate.accessToken === "string" &&
    candidate.accessToken.length > 0 &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt)
  );
}

function storedTokensFromResponse(response: AuthSession.TokenResponse, previous?: StoredTokens): StoredTokens {
  const expiresInSeconds = response.expiresIn ?? 3600;
  const issuedAtSeconds = response.issuedAt ?? Math.floor(Date.now() / 1000);
  return {
    accessToken: response.accessToken,
    ...(response.idToken || previous?.idToken ? { idToken: response.idToken ?? previous?.idToken } : {}),
    ...(response.refreshToken || previous?.refreshToken ? { refreshToken: response.refreshToken ?? previous?.refreshToken } : {}),
    expiresAt: (issuedAtSeconds + expiresInSeconds) * 1000,
    ...(response.tokenType ? { tokenType: response.tokenType } : {}),
  };
}

async function persistTokens(tokens: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_STORAGE_KEY, JSON.stringify(tokens), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function readStoredTokens(): Promise<StoredTokens | null> {
  const serialized = await SecureStore.getItemAsync(TOKEN_STORAGE_KEY);
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isStoredTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function signOutUrl(configuration: AuthConfiguration): string {
  const params = new URLSearchParams({
    client_id: configuration.clientId,
    logout_uri: configuration.redirectUri,
  });
  return `${configuration.domain}/logout?${params.toString()}`;
}

/**
 * Cognito authorization-code + PKCE authentication for an Expo development
 * client or signed native build. Tokens live in the OS credential store, never
 * AsyncStorage or an EXPO_PUBLIC_ value.
 */
export function useRepCoachAuth(): RepCoachAuth {
  const configResult = useMemo(readConfiguration, []);
  const configuration = configResult.configuration;
  const fallbackConfiguration = useMemo<AuthConfiguration>(
    () => ({
      clientId: configuration?.clientId ?? "repcoach-unconfigured-client",
      domain: configuration?.domain ?? "https://invalid.repcoach.example",
      redirectUri: configuration?.redirectUri ?? "repcoach://auth/callback",
      scopes: configuration?.scopes ?? DEFAULT_SCOPES,
    }),
    [configuration],
  );
  const discovery = useMemo(() => discoveryFor(fallbackConfiguration), [fallbackConfiguration]);
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: fallbackConfiguration.clientId,
      redirectUri: fallbackConfiguration.redirectUri,
      responseType: AuthSession.ResponseType.Code,
      scopes: fallbackConfiguration.scopes,
      usePKCE: true,
    },
    discovery,
  );

  const tokensRef = useRef<StoredTokens | null>(null);
  const processedCodeRef = useRef<string | null>(null);
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearLocalTokens = useCallback(async (): Promise<void> => {
    tokensRef.current = null;
    setUser(null);
    await SecureStore.deleteItemAsync(TOKEN_STORAGE_KEY);
  }, []);

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const current = tokensRef.current;
    if (!current) return null;
    if (current.expiresAt > Date.now() + EXPIRY_SKEW_MS) return current.accessToken;
    if (!current.refreshToken || !configuration) {
      await clearLocalTokens();
      return null;
    }

    try {
      const refreshed = await AuthSession.refreshAsync(
        { clientId: configuration.clientId, refreshToken: current.refreshToken },
        discoveryFor(configuration),
      );
      const nextTokens = storedTokensFromResponse(refreshed, current);
      tokensRef.current = nextTokens;
      await persistTokens(nextTokens);
      const nextUser = userFromTokens(nextTokens);
      if (!nextUser) throw new Error("The identity provider did not return a user subject.");
      setUser(nextUser);
      return nextTokens.accessToken;
    } catch {
      await clearLocalTokens();
      return null;
    }
  }, [clearLocalTokens, configuration]);

  const getAccessToken = useCallback(async (): Promise<string | null> => refreshAccessToken(), [refreshAccessToken]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const tokens = await readStoredTokens();
        if (!active || !tokens) return;
        tokensRef.current = tokens;
        const restoredUser = userFromTokens(tokens);
        if (!restoredUser) {
          await clearLocalTokens();
          return;
        }
        setUser(restoredUser);
        await refreshAccessToken();
      } catch {
        if (active) await clearLocalTokens();
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [clearLocalTokens, refreshAccessToken]);

  useEffect(() => {
    if (!response) return;
    if (response.type === "error") {
      setIsSigningIn(false);
      setError(response.error?.message ?? "Sign-in was not completed.");
      return;
    }
    if (response.type !== "success") {
      setIsSigningIn(false);
      return;
    }
    const codeVerifier = request?.codeVerifier;
    if (!configuration || !codeVerifier) return;

    const code = response.params.code;
    if (!code || processedCodeRef.current === code) return;
    processedCodeRef.current = code;
    setIsSigningIn(true);
    setError(null);

    void (async () => {
      try {
        const exchanged = await AuthSession.exchangeCodeAsync(
          {
            clientId: configuration.clientId,
            code,
            redirectUri: configuration.redirectUri,
            extraParams: { code_verifier: codeVerifier },
          },
          discoveryFor(configuration),
        );
        const tokens = storedTokensFromResponse(exchanged);
        const authenticatedUser = userFromTokens(tokens);
        if (!authenticatedUser) throw new Error("The identity provider did not return a user subject.");
        await persistTokens(tokens);
        tokensRef.current = tokens;
        setUser(authenticatedUser);
      } catch (authError) {
        await clearLocalTokens();
        setError(authError instanceof Error ? authError.message : "Could not complete secure sign-in.");
      } finally {
        setIsSigningIn(false);
      }
    })();
  }, [clearLocalTokens, configuration, request?.codeVerifier, response]);

  const signIn = useCallback(async (): Promise<void> => {
    if (!configuration) {
      setError(configResult.error ?? "Sign-in is not configured for this build.");
      return;
    }
    if (!request) {
      setError("Secure sign-in is still initializing. Try again in a moment.");
      return;
    }

    setError(null);
    setIsSigningIn(true);
    try {
      await promptAsync();
    } catch (authError) {
      setIsSigningIn(false);
      setError(authError instanceof Error ? authError.message : "Could not open secure sign-in.");
    }
  }, [configResult.error, configuration, promptAsync, request]);

  const signOut = useCallback(async (): Promise<void> => {
    const refreshToken = tokensRef.current?.refreshToken;
    await clearLocalTokens();
    setError(null);

    if (!configuration) return;
    try {
      if (refreshToken) {
        await AuthSession.revokeAsync(
          { clientId: configuration.clientId, token: refreshToken },
          discoveryFor(configuration),
        );
      }
      await WebBrowser.openAuthSessionAsync(signOutUrl(configuration), configuration.redirectUri);
    } catch {
      // Credentials are already removed locally. A transient hosted-UI failure
      // must not make local logout appear unsuccessful.
    }
  }, [clearLocalTokens, configuration]);

  return {
    user,
    isLoading,
    isSigningIn,
    error,
    isConfigured: configuration !== null,
    configurationError: configResult.error,
    signIn,
    signOut,
    getAccessToken,
  };
}

/** Replay data is intentionally unavailable from signed preview/production builds. */
export const isDevelopmentReplayEnabled = isDevelopmentBuild && trimValue(process.env.EXPO_PUBLIC_DEMO_MODE) !== "false";
