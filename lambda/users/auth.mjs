// Cognito JWT verification + admins-group gate. Mirrors kb_admin/auth.mjs
// but ALSO checks the `cognito:groups` claim — any user-management
// endpoint requires the caller to be in the `admins` group.

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

export async function authorizeAdmin(headers) {
  const lc = Object.fromEntries(
    Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const auth = lc.authorization || "";
  if (!auth.startsWith("Bearer ") && !auth.startsWith("bearer ")) {
    return { ok: false, status: 401, message: "missing Authorization: Bearer <token>" };
  }
  const token = auth.slice(7).trim();
  let claims;
  try {
    claims = await getVerifier().verify(token);
  } catch (e) {
    return { ok: false, status: 401, message: `JWT verification failed: ${String(e?.message || e)}` };
  }
  const groups = claims["cognito:groups"] || [];
  if (!Array.isArray(groups) || !groups.includes(ADMIN_GROUP)) {
    return {
      ok: false,
      status: 403,
      message: `caller is not in the "${ADMIN_GROUP}" group`,
    };
  }
  return {
    ok: true,
    identity: { sub: claims.sub, username: claims.username || claims["cognito:username"], groups },
  };
}
