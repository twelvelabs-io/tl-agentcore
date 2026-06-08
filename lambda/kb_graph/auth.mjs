// Verifies a Cognito access token (JWT). Mirrors tl_proxy/auth.mjs.

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

export async function authorize(headers) {
  const lc = Object.fromEntries(
    Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );

  const auth = lc.authorization || "";
  if (auth.startsWith("Bearer ") || auth.startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    try {
      const claims = await getVerifier().verify(token);
      return { ok: true, identity: { sub: claims.sub, username: claims.username || claims["cognito:username"] } };
    } catch (e) {
      return { ok: false, status: 401, message: `JWT verification failed: ${String(e?.message || e)}` };
    }
  }

  return { ok: false, status: 401, message: "missing Authorization: Bearer <token>" };
}
