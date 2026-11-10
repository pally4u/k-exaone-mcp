import { ConfigError } from "./domain/errors.js";
import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "./domain/model.js";

export interface AppConfig {
  /** 없으면 서버는 뜨지만 도구 호출 시 안내 메시지를 돌려준다. */
  apiKey?: string;
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  temperature: number;
  topP: number;
  preserveThinking: boolean;
  maxTokens?: number;
  timeoutMs: number;
  workDir: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxConversations: number;
  maxTurnsPerConversation: number;
}

export const DEFAULTS = {
  baseUrl: "https://api.exaone.ai/v1",
  model: "k-exaone_v2.5",
  reasoningEffort: "high" as ReasoningEffort,
  // EXAONE 문서 권장값: temperature=1.0, top_p=0.95, (agent·멀티턴) preserve_thinking=true
  temperature: 1.0,
  topP: 0.95,
  preserveThinking: true,
  timeoutMs: 600_000,
  maxFileKb: 1536,
  maxTotalKb: 1536,
  maxFiles: 20,
  maxConversations: 50,
  maxTurnsPerConversation: 20,
};

type Env = Record<string, string | undefined>;

/** 환경변수에서 설정을 읽는다. 잘못된 값은 시작 시점에 ConfigError로 알린다. */
export function loadConfig(env: Env = process.env, cwd = process.cwd()): AppConfig {
  const effort = (env.EXAONE_REASONING_EFFORT ?? DEFAULTS.reasoningEffort).trim().toLowerCase();
  if (!isReasoningEffort(effort)) {
    throw new ConfigError(`EXAONE_REASONING_EFFORT는 ${REASONING_EFFORTS.join(" / ")} 중 하나여야 합니다 (현재: ${effort}).`);
  }

  const apiKey = env.EXAONE_API_KEY?.trim();
  const maxTokens = optionalNumber(env, "EXAONE_MAX_TOKENS", { integer: true, min: 1 });

  const config: AppConfig = {
    baseUrl: (env.EXAONE_BASE_URL?.trim() || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: env.EXAONE_MODEL?.trim() || DEFAULTS.model,
    reasoningEffort: effort,
    temperature: optionalNumber(env, "EXAONE_TEMPERATURE", { min: 0 }) ?? DEFAULTS.temperature,
    topP: optionalNumber(env, "EXAONE_TOP_P", { min: 0, max: 1 }) ?? DEFAULTS.topP,
    preserveThinking: optionalBoolean(env, "EXAONE_PRESERVE_THINKING") ?? DEFAULTS.preserveThinking,
    timeoutMs: optionalNumber(env, "EXAONE_TIMEOUT_MS", { integer: true, min: 1000 }) ?? DEFAULTS.timeoutMs,
    workDir: env.EXAONE_WORKDIR?.trim() || cwd,
    maxFileBytes: (optionalNumber(env, "EXAONE_MAX_FILE_KB", { integer: true, min: 1 }) ?? DEFAULTS.maxFileKb) * 1024,
    maxTotalBytes: (optionalNumber(env, "EXAONE_MAX_TOTAL_KB", { integer: true, min: 1 }) ?? DEFAULTS.maxTotalKb) * 1024,
    maxFiles: DEFAULTS.maxFiles,
    maxConversations: DEFAULTS.maxConversations,
    maxTurnsPerConversation: DEFAULTS.maxTurnsPerConversation,
  };
  if (apiKey) config.apiKey = apiKey;
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  return config;
}

function optionalNumber(
  env: Env,
  name: string,
  rule: { integer?: boolean; min?: number; max?: number },
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  const invalid =
    !Number.isFinite(value) ||
    (rule.integer && !Number.isInteger(value)) ||
    (rule.min !== undefined && value < rule.min) ||
    (rule.max !== undefined && value > rule.max);
  if (invalid) {
    const range = [rule.min !== undefined ? `>= ${rule.min}` : "", rule.max !== undefined ? `<= ${rule.max}` : ""]
      .filter(Boolean)
      .join(", ");
    throw new ConfigError(`${name} 값이 올바르지 않습니다: "${raw}"${range ? ` (${range})` : ""}`);
  }
  return value;
}

function optionalBoolean(env: Env, name: string): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${name}는 true 또는 false여야 합니다 (현재: ${raw}).`);
}

/** 상태 출력용: 키 원문은 절대 노출하지 않고 끝 4자리만 보인다. */
export function maskKey(key: string | undefined): string {
  if (!key) return "(설정 안 됨)";
  return key.length <= 8 ? "****" : `****${key.slice(-4)}`;
}
