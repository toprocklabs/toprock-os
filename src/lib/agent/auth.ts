import { timingSafeEqual } from "node:crypto";

export const CRM_AGENT_TOKEN_MIN_LENGTH = 32;

export type AgentAuthFailure = {
  ok: false;
  status: 401 | 503;
  error: string;
};

export type AgentAuthSuccess = {
  ok: true;
};

export type AgentAuthResult = AgentAuthSuccess | AgentAuthFailure;

function readConfiguredToken(env: NodeJS.ProcessEnv = process.env) {
  return env.CRM_AGENT_TOKEN?.trim() ?? "";
}

export function getAgentTokenIssue(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = readConfiguredToken(env);
  if (!token) {
    return "CRM_AGENT_TOKEN is not set.";
  }
  if (token.length < CRM_AGENT_TOKEN_MIN_LENGTH) {
    return `CRM_AGENT_TOKEN must be at least ${CRM_AGENT_TOKEN_MIN_LENGTH} characters.`;
  }
  return null;
}

export function tokensEqual(provided: string, expected: string) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Consume a compare so length mismatches are not a cheap exit.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function extractBearerToken(authorization: string | null | undefined) {
  if (!authorization) {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export function authorizeAgentToken(
  authorization: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AgentAuthResult {
  const configIssue = getAgentTokenIssue(env);
  if (configIssue) {
    return { ok: false, status: 503, error: configIssue };
  }

  const provided = extractBearerToken(authorization);
  if (!provided || !tokensEqual(provided, readConfiguredToken(env))) {
    return { ok: false, status: 401, error: "Missing or invalid agent token." };
  }

  return { ok: true };
}

export function authorizeAgentRequest(request: Request, env: NodeJS.ProcessEnv = process.env) {
  return authorizeAgentToken(request.headers.get("authorization"), env);
}
