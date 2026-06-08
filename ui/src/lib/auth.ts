// Cognito authentication — two paths supported, both write the same
// `Tokens` object to localStorage so every downstream consumer
// (getAccessToken, decodeIdToken, isAdmin, agent-api) stays identical:
//
//   · LOCAL SRP (default) — amazon-cognito-identity-js drives a USER_SRP_AUTH
//     flow against the user pool. The password never leaves the browser
//     (SRP nonce-exchange). Rendered by the SignInScreen component.
//
//   · HOSTED UI PKCE (fallback) — preserved for the legacy ?code=…
//     callback URL so any in-flight OAuth-flow links still resolve.
//     We don't actively redirect to Hosted UI anymore.

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
  type CognitoUserAttribute,
} from "amazon-cognito-identity-js";

const ENV = (import.meta.env || {}) as Record<string, string | undefined>;
const HOSTED_UI = (ENV.VITE_COGNITO_HOSTED_UI_DOMAIN || "").replace(/\/$/, "");
const CLIENT_ID = ENV.VITE_COGNITO_CLIENT_ID || "";
const USER_POOL_ID = ENV.VITE_COGNITO_USER_POOL_ID || "";
const SCOPES = "openid email profile";

const LS_TOKENS = "tl-agentcore.tokens";
const LS_PKCE = "tl-agentcore.pkce-verifier";

let _pool: CognitoUserPool | null = null;
function getPool(): CognitoUserPool {
  if (_pool) return _pool;
  if (!USER_POOL_ID || !CLIENT_ID) {
    throw new Error("VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID must be set");
  }
  _pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
  return _pool;
}

function sessionToTokens(session: CognitoUserSession): Tokens {
  const access = session.getAccessToken();
  const id     = session.getIdToken();
  const refresh = session.getRefreshToken();
  return {
    access_token: access.getJwtToken(),
    id_token:     id.getJwtToken(),
    refresh_token: refresh.getToken(),
    expires_at:    access.getExpiration() * 1000,
  };
}

export type Tokens = {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_at: number; // ms epoch
};

export const cognitoEnabled = () => Boolean(CLIENT_ID && (USER_POOL_ID || HOSTED_UI));

const REDIRECT_URI = () => window.location.origin + "/";

function loadTokens(): Tokens | null {
  try { return JSON.parse(localStorage.getItem(LS_TOKENS) || "null"); }
  catch { return null; }
}
function saveTokens(t: Tokens) { localStorage.setItem(LS_TOKENS, JSON.stringify(t)); }
function clearTokens() {
  localStorage.removeItem(LS_TOKENS);
  localStorage.removeItem(LS_PKCE);
}

// PKCE — RFC 7636
function randStr(n: number) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"[b % 66]).join("");
}
async function sha256b64url(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startSignIn() {
  const verifier = randStr(64);
  const challenge = await sha256b64url(verifier);
  localStorage.setItem(LS_PKCE, verifier);
  const url = new URL(`${HOSTED_UI}/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI());
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.assign(url.toString());
}

async function exchangeCode(code: string): Promise<Tokens> {
  const verifier = localStorage.getItem(LS_PKCE);
  if (!verifier) throw new Error("PKCE verifier missing — sign-in flow was interrupted; re-try");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI(),
    code_verifier: verifier,
  });
  const r = await fetch(`${HOSTED_UI}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  const j = await r.json();
  localStorage.removeItem(LS_PKCE);
  return {
    access_token: j.access_token,
    id_token: j.id_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + j.expires_in * 1000,
  };
}

async function refreshTokens(refresh_token: string): Promise<Tokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token,
  });
  const r = await fetch(`${HOSTED_UI}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`refresh ${r.status}`);
  const j = await r.json();
  return {
    access_token: j.access_token,
    id_token: j.id_token || "",
    refresh_token: j.refresh_token || refresh_token,
    expires_at: Date.now() + j.expires_in * 1000,
  };
}

/** Try to recover tokens silently. Returns null without redirecting if
 *  the user isn't signed in — the caller (App.tsx) renders <SignInScreen>
 *  in that case. Still handles the legacy ?code=… callback so any
 *  bookmarked Hosted UI flow keeps working. */
export async function ensureSignedIn(): Promise<Tokens | null> {
  if (!cognitoEnabled()) return null;

  // Step 1 — legacy: handle a Hosted UI ?code=… callback if present.
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (code) {
    try {
      const tokens = await exchangeCode(code);
      saveTokens(tokens);
      url.searchParams.delete("code");
      url.searchParams.delete("state");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      return tokens;
    } catch (e) {
      console.warn("Hosted UI callback exchange failed", e);
    }
  }

  // Step 2 — load existing tokens; refresh if near expiry. Both code
  // paths (Hosted UI PKCE and local SRP) write the same Tokens shape so
  // this step is identical regardless of how the user signed in.
  const tokens = loadTokens();
  if (tokens && tokens.expires_at - Date.now() > 60_000) return tokens;
  if (tokens?.refresh_token) {
    try {
      const fresh = await refreshTokens(tokens.refresh_token);
      saveTokens(fresh);
      return fresh;
    } catch { /* fall through to "needs sign-in" */ }
  }
  return null; // App.tsx renders SignInScreen when this returns null.
}


// ─── Local SRP sign-in ──────────────────────────────────────────────────────
//
// All flows resolve to either:
//   { kind: "tokens", tokens } — full success; saved to localStorage.
//   { kind: "new_password_required", user, requiredAttributes } — first-
//     sign-in on an invited user; caller must collect a new password and
//     call completeNewPassword().
//   { kind: "mfa_required", user, deliveryDetails } — MFA enrolled
//     on this user; UI not built for this yet but the type is here so
//     callers can branch.
//
// Errors surface as thrown Error objects with helpful `.code` strings
// from Cognito (NotAuthorizedException, UserNotFoundException, etc).

export type SignInResult =
  | { kind: "tokens"; tokens: Tokens }
  | { kind: "new_password_required"; user: CognitoUser; requiredAttributes: string[] }
  | { kind: "mfa_required"; user: CognitoUser; mfaType: string };

export async function signInWithPassword(email: string, password: string): Promise<SignInResult> {
  const pool = getPool();
  const user = new CognitoUser({ Username: email.trim(), Pool: pool });
  const authDetails = new AuthenticationDetails({ Username: email.trim(), Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(authDetails, {
      onSuccess: (session) => {
        const tokens = sessionToTokens(session);
        saveTokens(tokens);
        resolve({ kind: "tokens", tokens });
      },
      onFailure: (err) => {
        const e = err as Error & { code?: string };
        const out = new Error(e.message || String(err)) as Error & { code?: string };
        out.code = e.code;
        reject(out);
      },
      newPasswordRequired: (userAttributes, requiredAttributes) => {
        // Cognito sends back the user's current attributes here; strip
        // the ones we can't write back (email_verified is system-managed
        // and the SDK rejects it).
        delete userAttributes.email_verified;
        delete userAttributes.sub;
        resolve({ kind: "new_password_required", user, requiredAttributes: requiredAttributes || [] });
      },
      mfaRequired: (mfaType) => {
        resolve({ kind: "mfa_required", user, mfaType });
      },
    });
  });
}

/** Finish the first-sign-in challenge by submitting a new password. */
export async function completeNewPassword(user: CognitoUser, newPassword: string, attributes: Record<string, string> = {}): Promise<Tokens> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, attributes, {
      onSuccess: (session: CognitoUserSession) => {
        const tokens = sessionToTokens(session);
        saveTokens(tokens);
        resolve(tokens);
      },
      onFailure: (err: Error) => reject(err),
    });
  });
}

/** Trigger the "forgot password" email. Cognito emails a 6-digit code. */
export async function forgotPassword(email: string): Promise<void> {
  const pool = getPool();
  const user = new CognitoUser({ Username: email.trim(), Pool: pool });
  return new Promise((resolve, reject) => {
    user.forgotPassword({
      onSuccess: () => resolve(),
      onFailure: (err) => reject(err),
    });
  });
}

/** Confirm the forgot-password flow with the emailed code + new password. */
export async function confirmForgotPassword(email: string, code: string, newPassword: string): Promise<void> {
  const pool = getPool();
  const user = new CognitoUser({ Username: email.trim(), Pool: pool });
  return new Promise((resolve, reject) => {
    user.confirmPassword(code.trim(), newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err) => reject(err),
    });
  });
}

export async function getAccessToken(): Promise<string | null> {
  if (!cognitoEnabled()) return null;
  const tokens = loadTokens();
  if (!tokens) return null;
  if (tokens.expires_at - Date.now() > 60_000) return tokens.access_token;
  if (tokens.refresh_token) {
    try {
      const fresh = await refreshTokens(tokens.refresh_token);
      saveTokens(fresh);
      return fresh.access_token;
    } catch { return null; }
  }
  return null;
}

export function decodeIdToken(): { email?: string; name?: string; sub?: string; "cognito:groups"?: string[] } | null {
  const t = loadTokens();
  if (!t?.id_token) return null;
  try {
    const payload = t.id_token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }
}

/** Decode the *access* token (different from the id token — only access
 *  tokens carry `cognito:groups` reliably). Returns null if absent or
 *  unparseable. */
export function decodeAccessToken(): { sub?: string; username?: string; "cognito:groups"?: string[] } | null {
  const t = loadTokens();
  if (!t?.access_token) return null;
  try {
    const payload = t.access_token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }
}

/** True when the signed-in user's access token carries the `admins` group
 *  claim. Used to gate admin-only UI like the Users tab. */
export function isAdmin(): boolean {
  const tok = decodeAccessToken();
  const groups = tok?.["cognito:groups"];
  return Array.isArray(groups) && groups.includes("admins");
}

export function signOut() {
  // Best-effort global sign-out on the Cognito side so the refresh token
  // can't be reused. The actual gate is that we clear the tokens out of
  // localStorage immediately; the network call is fire-and-forget.
  try {
    const pool = getPool();
    pool.getCurrentUser()?.signOut();
  } catch { /* pool not configured locally — fine */ }
  clearTokens();
  // Reload so App.tsx re-runs ensureSignedIn → renders the sign-in screen.
  window.location.assign("/");
}

// Reference to keep the legacy Hosted UI helpers in scope (silences
// unused-import warnings if startSignIn is ever removed). The Hosted UI
// path is only exercised by the ?code=… callback above.
export const _legacyHostedUi = { startSignIn };
const _suppress_unused_legacy = SCOPES;
void _suppress_unused_legacy;
