// Verifies a Cognito access token (JWT). Mirrors kb_admin/auth.mjs.
//
// Exports two verifiers:
//   - authorize:       any signed-in user (used for GET, so every user
//                      can see the currently-active prompts)
//   - authorizeAdmin:  only users in the `admins` Cognito group (used
//                      for PUT/DELETE — the system prompts are global
//                      and load-bearing, so mutations are a privileged
//                      operation)

import { CognitoJwtVerifier } from "aws-jwt-verify";

let verifier;
function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse:   "access",
      clientId:   process.env.COGNITO_CLIENT_ID,
    });
  }
  return verifier;
}

const ADMIN_GROUP = process.env.ADMIN_GROUP_NAME || "admins";

export async function authorize(headers) {
  const lc = Object.fromEntries(
    Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );

  const auth = lc.authorization || "";
  if (auth.startsWith("Bearer ") || auth.startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    try {
      const claims = await getVerifier().verify(token);
      const groups = Array.isArray(claims["cognito:groups"]) ? claims["cognito:groups"] : [];
      return {
        ok: true,
        identity: {
          sub: claims.sub,
          username: claims.username || claims["cognito:username"],
          groups,
        },
      };
    } catch (e) {
      return { ok: false, status: 401, message: `JWT verification failed: ${String(e?.message || e)}` };
    }
  }

  return { ok: false, status: 401, message: "missing Authorization: Bearer <token>" };
}

export async function authorizeAdmin(headers) {
  const auth = await authorize(headers);
  if (!auth.ok) return auth;
  if (!auth.identity.groups.includes(ADMIN_GROUP)) {
    return { ok: false, status: 403, message: `caller is not in the "${ADMIN_GROUP}" group` };
  }
  return auth;
}
