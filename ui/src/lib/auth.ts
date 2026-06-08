// Cognito OAuth code flow with PKCE.
// Pure browser implementation — no SDK needed (saves ~120KB).
//
// Lifecycle:
//   1. App boots → load tokens from localStorage; if missing/expired, kick off PKCE flow.
//   2. Hosted UI redirects back with ?code=… → exchange for {access,id,refresh} tokens.
//   3. Every API call: getAccessToken() refreshes if within 60s of expiry.
//   4. signOut() clears localStorage + redirects through /logout to clear the IdP cookie.

const ENV = (import.meta.env || {}) as Record<string, string | undefined>;
const HOSTED_UI = (ENV.VITE_COGNITO_HOSTED_UI_DOMAIN || "").replace(/\/$/, "");
const CLIENT_ID = ENV.VITE_COGNITO_CLIENT_ID || "";
const SCOPES = "openid email profile";

const LS_TOKENS = "tl-agentcore.tokens";
const LS_PKCE = "tl-agentcore.pkce-verifier";

export type Tokens = {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_at: number; // ms epoch
};

export const cognitoEnabled = () => Boolean(HOSTED_UI && CLIENT_ID);

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

export async function ensureSignedIn(): Promise<Tokens | null> {
  if (!cognitoEnabled()) return null;

  // Step 1 — handle the OAuth callback if we landed here with ?code=…
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (code) {
    const tokens = await exchangeCode(code);
    saveTokens(tokens);
    // Strip the code from the URL.
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    return tokens;
  }

  // Step 2 — load existing tokens; refresh if near expiry; sign in if missing.
  const tokens = loadTokens();
  if (tokens && tokens.expires_at - Date.now() > 60_000) return tokens;
  if (tokens?.refresh_token) {
    try {
      const fresh = await refreshTokens(tokens.refresh_token);
      saveTokens(fresh);
      return fresh;
    } catch { /* fall through to sign-in */ }
  }
  await startSignIn();
  // startSignIn navigates away; this Promise resolves on next page load.
  return null;
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
  clearTokens();
  if (!cognitoEnabled()) { window.location.assign("/"); return; }
  const url = new URL(`${HOSTED_UI}/logout`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("logout_uri", REDIRECT_URI());
  window.location.assign(url.toString());
}
