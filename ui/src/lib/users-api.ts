// Users API client — admin-only Cognito user CRUD. Mirrors the shape of
// settings-api.ts; the lambda gates every route on the `admins` group.

import { getAccessToken } from "./auth";

const BASE = "/users";

export type User = {
  // `username` here is the user's email — that's the actual Cognito
  // identifier our pool uses (UsernameAttributes: ["email"]) and is
  // what every admin endpoint expects in the path.
  username: string;
  // The immutable sub UUID. For display / debugging only — admin APIs
  // reject it as `Username`.
  sub: string;
  email: string;
  status: string;          // CONFIRMED | FORCE_CHANGE_PASSWORD | RESET_REQUIRED | …
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
  groups: string[];
  is_admin: boolean;
};

export type UsersResponse = { users: User[] };

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* keep as string */ }
  if (!res.ok) {
    const detail = typeof data === "string"
      ? data
      : data?.error || data?.message || JSON.stringify(data);
    const err = new Error(`${method} ${path} → ${res.status}: ${detail}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return data as T;
}

export const listUsers   = ()                                  => call<UsersResponse>("GET",    "");
export const inviteUser  = (email: string)                     => call("POST",   "", { email });
export const deleteUser  = (username: string)                  => call("DELETE", `/${encodeURIComponent(username)}`);
export const resetPwd    = (username: string)                  => call("POST",   `/${encodeURIComponent(username)}/reset-password`);
export const resendInv   = (username: string)                  => call("POST",   `/${encodeURIComponent(username)}/resend-invite`);
export const enableUser  = (username: string)                  => call("POST",   `/${encodeURIComponent(username)}/enable`);
export const disableUser = (username: string)                  => call("POST",   `/${encodeURIComponent(username)}/disable`);
