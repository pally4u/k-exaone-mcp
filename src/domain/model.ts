/**
 * 도메인 모델: 프레임워크·HTTP·MCP에 의존하지 않는 순수 타입과 규칙.
 */

export const REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
  /** preserve_thinking 사용 시 이전 assistant 턴의 추론을 다음 요청에 넘기기 위해 보관한다. */
  reasoning_content?: string;
}

/** 모델 호출 시 고정으로 쓰는 생성 파라미터. */
export interface GenerationSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  temperature: number;
  topP: number;
  maxTokens?: number;
  preserveThinking: boolean;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  settings: GenerationSettings;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface RateLimitWindow {
  limit?: number;
  remaining?: number;
}

/** 응답 헤더(x-{second|minute|day}-rate-limit[-remaining], retry-after[-ms])에서 읽은 호출 한도. */
export interface RateLimitSnapshot {
  second?: RateLimitWindow;
  minute?: RateLimitWindow;
  day?: RateLimitWindow;
  retryAfterMs?: number;
  requestId?: string;
  observedAt: Date;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  finishReason?: string;
  model?: string;
  usage?: Usage;
  rateLimit?: RateLimitSnapshot;
  elapsedMs: number;
}

/** 스트리밍 중 진행 상황 알림. */
export interface CompletionProgress {
  phase: "reasoning" | "answer";
  reasoningChars: number;
  contentChars: number;
}

export function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
