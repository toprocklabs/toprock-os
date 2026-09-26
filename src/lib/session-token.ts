import { jwtVerify, SignJWT } from "jose";

// The session JWT on its own, with no next/headers dependency, so the proxy and
// getSession() verify cookies with the same code (planning/009-web-ui-behind-login).

export const SESSION_COOKIE = "crm_session";
export const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 14;

export type SessionUser = {
  userId: number;
  username: string;
};

function getAuthSecret() {
  const secret = process.env.AUTH_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET must be set and at least 32 characters long.");
  }

  return new TextEncoder().encode(secret);
}

export async function signSessionToken(user: SessionUser) {
  return new SignJWT(user)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("14d")
    .sign(getAuthSecret());
}

export async function verifySessionToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getAuthSecret(), { algorithms: ["HS256"] });

    if (typeof payload.userId !== "number" || typeof payload.username !== "string") {
      return null;
    }

    return {
      userId: payload.userId,
      username: payload.username,
    };
  } catch {
    return null;
  }
}
