// users — admin-only Cognito user-management surface for the SPA's
// Settings → Users tab. Every route requires the caller's JWT to carry
// `cognito:groups` containing the `admins` group (enforced by
// auth.mjs#authorizeAdmin). The Cognito user pool itself has
// `AllowAdminCreateUserOnly: true` so there's no self-registration path
// elsewhere — invites must go through this lambda.
//
// Routes:
//   GET    /users                                  → list users (incl. groups, status, enabled flag)
//   POST   /users                                  → { email, send_invite?: bool } → admin-create-user
//   DELETE /users/{username}                       → admin-delete-user
//   POST   /users/{username}/reset-password        → admin-reset-user-password (forces re-set on next sign-in)
//   POST   /users/{username}/resend-invite         → admin-create-user RESEND
//   POST   /users/{username}/enable                → admin-enable-user
//   POST   /users/{username}/disable               → admin-disable-user

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminResetUserPasswordCommand,
  AdminEnableUserCommand,
  AdminDisableUserCommand,
  AdminListGroupsForUserCommand,
  MessageActionType,
} from "@aws-sdk/client-cognito-identity-provider";

import { authorizeAdmin } from "./auth.mjs";

const cog = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const ADMIN_GROUP = process.env.ADMIN_GROUP_NAME || "admins";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const cors = () => ({
  statusCode: 204,
  headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-demo-password",
  },
  body: "",
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function attr(user, name) {
  return (user?.Attributes || user?.UserAttributes || []).find((a) => a.Name === name)?.Value;
}

async function listAllUsers() {
  const out = [];
  let token = undefined;
  do {
    const r = await cog.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Limit: 60,
      PaginationToken: token,
    }));
    for (const u of r.Users || []) out.push(u);
    token = r.PaginationToken;
  } while (token);
  // Enrich each with their group memberships in parallel. Cognito caps
  // admin-list-groups-for-user at 60-ish concurrent calls; the pool is
  // small here, so a flat Promise.all is fine.
  const groups = await Promise.all(out.map(async (u) => {
    try {
      const r = await cog.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: u.Username,
      }));
      return (r.Groups || []).map((g) => g.GroupName);
    } catch {
      return [];
    }
  }));
  return out.map((u, i) => {
    // This pool is configured with UsernameAttributes:["email"], so
    // Cognito returns the sub UUID as `Username` but every admin API
    // (AdminResetUserPassword, AdminCreateUser-RESEND, AdminDeleteUser,
    // ...) actually expects the EMAIL as its `Username` parameter.
    // Surface the email under `username` so the SPA can pass it
    // straight back into the admin endpoints; expose the underlying
    // sub separately for display / dedup.
    const email = attr(u, "email") || u.Username;
    return {
      username:   email,
      sub:        u.Username,
      email,
      status:     u.UserStatus,
      enabled:    u.Enabled !== false,
      created_at: u.UserCreateDate?.toISOString?.() || null,
      updated_at: u.UserLastModifiedDate?.toISOString?.() || null,
      groups:     groups[i],
      is_admin:   groups[i].includes(ADMIN_GROUP),
    };
  });
}

async function createUser(email) {
  if (!email || !EMAIL_RE.test(email)) {
    return json(400, { error: "valid email required" });
  }
  try {
    const r = await cog.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: "email",          Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
      // Cognito generates a temp password and emails the user the
      // configured invite template (see InviteMessageTemplate on the
      // pool). The user must change it on first sign-in.
    }));
    return json(201, { user: { username: r.User?.Username, status: r.User?.UserStatus } });
  } catch (e) {
    if (e?.name === "UsernameExistsException") {
      return json(409, { error: "user already exists", code: "UsernameExistsException" });
    }
    return json(500, { error: String(e?.message || e), code: e?.name });
  }
}

async function deleteUser(username, callerSub) {
  // Defensive: prevent an admin from deleting themselves and locking
  // the pool out of admin access.
  try {
    const me = await cog.send(new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID, Username: username,
    }));
    const subAttr = (me.UserAttributes || []).find((a) => a.Name === "sub")?.Value;
    if (subAttr && callerSub && subAttr === callerSub) {
      return json(400, { error: "cannot delete your own account from the admin panel" });
    }
  } catch { /* if the lookup fails just proceed to delete */ }
  try {
    await cog.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    return json(200, { deleted: username });
  } catch (e) {
    return json(500, { error: String(e?.message || e), code: e?.name });
  }
}

async function resetPassword(username) {
  try {
    await cog.send(new AdminResetUserPasswordCommand({
      UserPoolId: USER_POOL_ID, Username: username,
    }));
    return json(200, { reset: username });
  } catch (e) {
    return json(500, { error: String(e?.message || e), code: e?.name });
  }
}

async function resendInvite(username) {
  // RESEND on admin-create-user re-fires the invitation email with a
  // fresh temp password. Only works for users still in
  // FORCE_CHANGE_PASSWORD state.
  try {
    await cog.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      MessageAction: MessageActionType.RESEND,
      DesiredDeliveryMediums: ["EMAIL"],
    }));
    return json(200, { resent: username });
  } catch (e) {
    return json(500, { error: String(e?.message || e), code: e?.name });
  }
}

async function enableUser(username) {
  try {
    await cog.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    return json(200, { enabled: username });
  } catch (e) {
    return json(500, { error: String(e?.message || e), code: e?.name });
  }
}

async function disableUser(username, callerSub) {
  try {
    const me = await cog.send(new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID, Username: username,
    }));
    const subAttr = (me.UserAttributes || []).find((a) => a.Name === "sub")?.Value;
    if (subAttr && callerSub && subAttr === callerSub) {
      return json(400, { error: "cannot disable your own account from the admin panel" });
    }
  } catch { /* */ }
  try {
    await cog.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    return json(200, { disabled: username });
  } catch (e) {
    return json(500, { error: String(e?.message || e), code: e?.name });
  }
}

// ── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return cors();

  const auth = await authorizeAdmin(event.headers || {});
  if (!auth.ok) return json(auth.status, { error: auth.message });
  const callerSub = auth.identity?.sub;

  if (!USER_POOL_ID) {
    return json(500, { error: "COGNITO_USER_POOL_ID env not set" });
  }

  let body = null;
  if (event.body) {
    try { body = JSON.parse(event.body); }
    catch { return json(400, { error: "invalid JSON body" }); }
  }
  const path = event.rawPath || event.requestContext?.http?.path || "";

  // GET /users
  if (method === "GET" && /^\/users\/?$/.test(path)) {
    try {
      const users = await listAllUsers();
      return json(200, { users });
    } catch (e) {
      console.error("users: list failed", e);
      return json(500, { error: String(e?.message || e) });
    }
  }

  // POST /users  → create
  if (method === "POST" && /^\/users\/?$/.test(path)) {
    return await createUser(body?.email);
  }

  const subRoute = path.match(/^\/users\/([^/]+)(?:\/([a-z-]+))?\/?$/);
  if (subRoute) {
    const username = decodeURIComponent(subRoute[1]);
    const action = subRoute[2];

    if (method === "DELETE" && !action) return await deleteUser(username, callerSub);

    if (method === "POST") {
      if (action === "reset-password")  return await resetPassword(username);
      if (action === "resend-invite")   return await resendInvite(username);
      if (action === "enable")          return await enableUser(username);
      if (action === "disable")         return await disableUser(username, callerSub);
    }
  }

  return json(404, { error: `unknown route ${method} ${path}` });
};
