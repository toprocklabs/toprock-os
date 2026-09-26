import { sql } from "drizzle-orm";
import type { CrmDb } from "@/lib/db";
import { loginAttempts } from "@/lib/schema";

// Brute-force limits for the public /login form (planning/009-web-ui-behind-login).
//
// Counts live in Postgres, not memory: Vercel runs several instances at once and
// an in-process counter would let an attacker spread guesses across them.

export const LOGIN_WINDOW_MINUTES = 15;
export const MAX_FAILURES_PER_USERNAME = 5;
export const MAX_FAILURES_PER_IP = 20;
export const LOGIN_ATTEMPT_RETENTION_DAYS = 30;

export type RecentFailures = {
  /** Failures for this username in the window, since its last successful login. */
  usernameFailures: number;
  /** Failures from this IP in the window, across every username. */
  ipFailures: number;
};

export function isThrottled({ usernameFailures, ipFailures }: RecentFailures) {
  return usernameFailures >= MAX_FAILURES_PER_USERNAME || ipFailures >= MAX_FAILURES_PER_IP;
}

/** First hop of x-forwarded-for, which Vercel sets from the real client address. */
export function clientIp(forwardedFor: string | null, realIp: string | null) {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || realIp?.trim() || "unknown";
}

export async function countRecentFailures(
  db: CrmDb,
  username: string,
  ip: string,
  now: Date = new Date(),
): Promise<RecentFailures> {
  const since = new Date(now.getTime() - LOGIN_WINDOW_MINUTES * 60_000);

  const result = await db.execute<{ username_failures: number; ip_failures: number }>(sql`
    with last_success as (
      select max(created_at) as at
      from ${loginAttempts}
      where username = ${username} and succeeded
    )
    select
      count(*) filter (
        where username = ${username}
          and not succeeded
          and created_at > coalesce(greatest((select at from last_success), ${since}), ${since})
      )::int as username_failures,
      count(*) filter (where ip = ${ip} and not succeeded)::int as ip_failures
    from ${loginAttempts}
    where created_at > ${since} and (username = ${username} or ip = ${ip})
  `);

  const row = result.rows[0];

  return {
    usernameFailures: Number(row?.username_failures ?? 0),
    ipFailures: Number(row?.ip_failures ?? 0),
  };
}

export async function recordLoginAttempt(
  db: CrmDb,
  attempt: { username: string; ip: string; succeeded: boolean },
  now: Date = new Date(),
) {
  const cutoff = new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_DAYS * 86_400_000);

  await db.insert(loginAttempts).values(attempt);
  // Opportunistic retention: one indexed delete per attempt keeps the table
  // small without a cron.
  await db.delete(loginAttempts).where(sql`${loginAttempts.createdAt} < ${cutoff}`);
}
