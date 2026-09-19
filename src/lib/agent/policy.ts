const DEFAULT_AUTO_APPLY_KINDS = ["log_activity"];
const DEFAULT_MIN_CONFIDENCE = 95;

export type AutoApplyPolicyInput = {
  kind: string;
  confidence: number;
};

export type AutoApplyPolicyEnv = Record<string, string | undefined>;

export function isAutoApplyEnabled(env: AutoApplyPolicyEnv = process.env) {
  return env.CRM_AGENT_AUTO_APPLY === "true";
}

export function parseAutoApplyKinds(env: AutoApplyPolicyEnv = process.env) {
  const raw = env.CRM_AGENT_AUTO_APPLY_KINDS?.trim();
  if (!raw) {
    return DEFAULT_AUTO_APPLY_KINDS;
  }
  return raw
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
}

export function autoApplyMinConfidence(env: AutoApplyPolicyEnv = process.env) {
  const parsed = Number(env.CRM_AGENT_AUTO_APPLY_MIN_CONFIDENCE);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MIN_CONFIDENCE;
  }
  return Math.min(100, Math.max(0, Math.floor(parsed)));
}

// High-confidence auto-apply is off unless CRM_AGENT_AUTO_APPLY=true.
// Any kind listed in CRM_AGENT_AUTO_APPLY_KINDS can auto-apply once
// confidence meets CRM_AGENT_AUTO_APPLY_MIN_CONFIDENCE (default 95).
// Default allowlist is log_activity only.
export function shouldAutoApply(
  input: AutoApplyPolicyInput,
  env: AutoApplyPolicyEnv = process.env,
) {
  if (!isAutoApplyEnabled(env)) {
    return false;
  }
  if (input.confidence < autoApplyMinConfidence(env)) {
    return false;
  }
  return parseAutoApplyKinds(env).includes(input.kind);
}
