import type { AskOutput, StatusOutput } from "../application/exaoneService.js";
import { formatBytes } from "../domain/attachments.js";
import { AttachmentError, ConfigError, ConversationNotFoundError, ExaoneApiError } from "../domain/errors.js";
import type { RateLimitSnapshot, Usage } from "../domain/model.js";

const n = (value: number) => value.toLocaleString("en-US");

export function formatUsage(usage: Usage | undefined): string {
  if (!usage) return "tokens: (응답에 usage 없음)";
  return `tokens: in ${n(usage.promptTokens)} / out ${n(usage.completionTokens)} (reasoning ${n(usage.reasoningTokens)})`;
}

export function formatRateLimit(rl: RateLimitSnapshot | undefined): string {
  if (!rl) return "rate limit: (헤더 없음)";
  const parts: string[] = [];
  for (const window of ["second", "minute", "day"] as const) {
    const w = rl[window];
    if (!w) continue;
    parts.push(`${window} ${w.remaining ?? "?"}/${w.limit ?? "?"}`);
  }
  if (rl.retryAfterMs !== undefined) parts.push(`retry-after ${Math.ceil(rl.retryAfterMs / 1000)}s`);
  return `rate limit remaining: ${parts.length ? parts.join(", ") : "(헤더 없음)"}`;
}

export function formatAnswer(output: AskOutput, effort: string, includeReasoning: boolean): string {
  const { result } = output;
  const sections: string[] = [];

  if (includeReasoning && result.reasoning) {
    sections.push(`<exaone_reasoning>\n${result.reasoning}\n</exaone_reasoning>`);
  }
  sections.push(result.content || "(빈 응답)");

  const meta = [
    `conversation_id: ${output.conversationId} (turn ${output.turn})`,
    `model: ${result.model ?? "?"} · effort: ${effort} · ${(result.elapsedMs / 1000).toFixed(1)}s` +
      (result.finishReason && result.finishReason !== "stop" ? ` · finish_reason: ${result.finishReason}` : ""),
    formatUsage(result.usage),
    formatRateLimit(result.rateLimit),
  ];
  if (output.attachedFiles.length) meta.push(`attached: ${output.attachedFiles.join(", ")}`);
  if (result.finishReason === "length") {
    meta.push("⚠ max_tokens에 도달해 답변이 잘렸을 수 있습니다. max_tokens를 늘리거나 reasoning_effort를 낮추세요.");
  }

  sections.push(`---\n[k-exaone-mcp]\n${meta.join("\n")}`);
  return sections.join("\n\n");
}

export function formatStatus(status: StatusOutput, maskedKey: string, extra: { maxFileBytes: number; maxTotalBytes: number; workDir: string }): string {
  const s = status.settings;
  const { ledger } = status;
  const lines = [
    "# k-exaone-mcp status",
    "",
    "## 설정",
    `- API key: ${maskedKey}`,
    `- model: ${s.model}`,
    `- reasoning_effort (기본): ${s.reasoningEffort}`,
    `- temperature: ${s.temperature}, top_p: ${s.topP}, preserve_thinking: ${s.preserveThinking}`,
    `- max_tokens (기본): ${s.maxTokens ?? "제한 없음(서버 기본)"}`,
    `- 첨부 한도: 파일당 ${formatBytes(extra.maxFileBytes)}, 합계 ${formatBytes(extra.maxTotalBytes)}`,
    `- 상대 경로 기준 폴더: ${extra.workDir}`,
    "",
    "## 이 서버 프로세스의 누적 사용량",
    `- 시작: ${ledger.startedAt.toISOString()}`,
    `- 호출: ${ledger.calls}회 (실패 ${ledger.failures}회), 보관 중인 대화: ${status.conversations}개`,
    `- ${formatUsage(ledger.usage)}, total ${n(ledger.usage.totalTokens)}`,
    `- ${formatRateLimit(ledger.lastRateLimit)}` +
      (ledger.lastRateLimit ? ` (관측 시각 ${ledger.lastRateLimit.observedAt.toISOString()})` : ""),
  ];

  if (status.ping) {
    lines.push("", "## 연결 확인 (ping)");
    if (status.ping.ok) {
      const r = status.ping.result;
      lines.push(
        `- 결과: 성공 (${(r.elapsedMs / 1000).toFixed(1)}s, model ${r.model ?? "?"})`,
        `- 응답: ${r.content.slice(0, 80)}`,
        `- ${formatUsage(r.usage)}`,
        `- ${formatRateLimit(r.rateLimit)}`,
      );
      if (r.rateLimit?.requestId) lines.push(`- x-request-id: ${r.rateLimit.requestId}`);
    } else {
      lines.push(`- 결과: 실패 — ${status.ping.error}`);
    }
  }
  lines.push("", "참고: EXAONE API는 남은 호출 횟수를 응답 헤더로만 알려 줍니다. 계정 전체 사용량은 EXAONE API Platform 콘솔에서 확인하세요.");
  return lines.join("\n");
}

/** 오류를 사용자(그리고 호출한 AI)가 다음 행동을 정할 수 있는 문장으로 바꾼다. */
export function formatError(error: unknown): string {
  if (error instanceof ExaoneApiError) {
    const id = error.rateLimit?.requestId ? `\n(x-request-id: ${error.rateLimit.requestId})` : "";
    return `${error.message}${id}`;
  }
  if (error instanceof AttachmentError || error instanceof ConfigError || error instanceof ConversationNotFoundError) {
    return error.message;
  }
  return `예상하지 못한 오류: ${error instanceof Error ? error.message : String(error)}`;
}
