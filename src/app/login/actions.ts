"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession, clearSession, getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  clientIp,
  countRecentFailures,
  isThrottled,
  recordLoginAttempt,
} from "@/lib/login-throttle";
import { safeNextPath } from "@/lib/public-surface";
import { users } from "@/lib/schema";
import { compare } from "bcryptjs";

// Compared against when the username doesn't exist, so an unknown user costs the
// same bcrypt work (and returns the same error) as a wrong password.
const DUMMY_PASSWORD_HASH = "$2b$12$Y29uAl/RYPmHHva8fAW6.eeLczYtNpO1BNw0ABcQQiJhTtby22YnC";

const loginSchema = z.object({
  username: z.string().trim().min(3).max(50),
  password: z.string().min(6).max(100),
});

export async function login(formData: FormData) {
  const db = getDb();
  const next = safeNextPath(formData.get("next"));
  const fail = (error: string): never => {
    const params = new URLSearchParams({ error });
    if (next) params.set("next", next);
    redirect(`/login?${params.toString()}`);
  };

  if (!db) {
    return fail("config");
  }

  const parsed = loginSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return fail("invalid");
  }

  const username = parsed.data.username.toLowerCase();
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders.get("x-forwarded-for"), requestHeaders.get("x-real-ip"));

  // Refused before the password is even checked, and not recorded: a locked
  // username stays locked only until the window rolls off.
  if (isThrottled(await countRecentFailures(db, username, ip))) {
    return fail("throttled");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.username, username),
  });

  const passwordValid = await compare(
    parsed.data.password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );
  const succeeded = Boolean(user) && passwordValid;

  await recordLoginAttempt(db, { username, ip, succeeded });

  if (!user || !succeeded) {
    return fail("invalid");
  }

  await createSession({
    userId: user.id,
    username: user.username,
  });

  redirect(next ?? "/");
}

export async function logout() {
  await clearSession();
  redirect("/login");
}

export async function redirectIfAuthenticated() {
  const session = await getSession();

  if (session) {
    redirect("/");
  }
}
