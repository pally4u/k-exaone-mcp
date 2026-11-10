import { ExaoneApiError } from "../domain/errors.js";
import type {
  ChatMessage,
  CompletionProgress,
  CompletionRequest,
  CompletionResult,
  RateLimitSnapshot,
  Usage,
} from "../domain/model.js";
import type { ChatCompletionPort } from "../domain/ports.js";
import { parseRateLimitHeaders } from "./rateLimitHeaders.js";
import { SseParser } from "./sseParser.js";

export interface ExaoneHttpClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** 진행 알림 최소 간격 */
  progressIntervalMs?: number;
  /** 429를 받았을 때 자동 재시도 횟수 (초당 한도용). 기본 2 */
  maxRetries?: number;
  /** retry-after가 이보다 길면 재시도하지 않고 바로 오류를 돌려준다 (일일 한도 소진 등). 기본 10초 */
  maxRetryWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });

/** OpenAI 호환 응답 중 이 클라이언트가 읽는 부분만 정의한다. */
interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

interface RawChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: RawUsage | null;
  result_code?: number;
  description?: string;
  error?: { message?: string } | string;
}

/**
 * EXAONE API(OpenAI 호환 /v1/chat/completions) 클라이언트.
 * 긴 추론 중 연결이 끊기지 않도록 항상 스트리밍으로 받고, 결과를 하나로 합친다.
 */
export class ExaoneHttpClient implements ChatCompletionPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ExaoneHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(
    request: CompletionRequest,
    callOptions: { signal?: AbortSignal; onProgress?: (p: CompletionProgress) => void } = {},
  ): Promise<CompletionResult> {
    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = callOptions.signal ? AbortSignal.any([callOptions.signal, timeout]) : timeout;

    const maxRetries = this.options.maxRetries ?? 2;
    const maxWait = this.options.maxRetryWaitMs ?? 10_000;
    const sleep = this.options.sleep ?? defaultSleep;

    let response: Response;
    let rateLimit: RateLimitSnapshot | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream, application/json",
          },
          body: JSON.stringify(buildBody(request)),
          signal,
        });
      } catch (error) {
        throw toNetworkError(error, timeout, this.options.timeoutMs);
      }

      rateLimit = parseRateLimitHeaders(response.headers);
      if (response.ok) break;

      const text = await response.text().catch(() => "");
      // 초당 한도(1회/초)에 걸린 경우만 잠깐 기다렸다가 다시 보낸다. 일일 한도 소진은 바로 알린다.
      const wait = response.status === 429 ? retryWaitMs(rateLimit) : undefined;
      if (wait !== undefined && wait <= maxWait && attempt < maxRetries) {
        try {
          await sleep(wait, signal);
        } catch (error) {
          throw toNetworkError(error, timeout, this.options.timeoutMs);
        }
        continue;
      }
      throw new ExaoneApiError(describeHttpError(response.status, text, rateLimit), response.status, rateLimit);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const acc = new Accumulator();
    try {
      if (contentType.includes("text/event-stream") && response.body) {
        await this.readStream(response.body, acc, callOptions.onProgress);
      } else {
        acc.apply(JSON.parse(await response.text()) as RawChunk);
      }
    } catch (error) {
      if (error instanceof ExaoneApiError) throw error;
      throw toNetworkError(error, timeout, this.options.timeoutMs);
    }

    return acc.toResult(Date.now() - startedAt, rateLimit);
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    acc: Accumulator,
    onProgress?: (p: CompletionProgress) => void,
  ): Promise<void> {
    const parser = new SseParser();
    const decoder = new TextDecoder("utf-8");
    const interval = this.options.progressIntervalMs ?? 1000;
    let lastProgress = 0;

    const handle = (events: string[]) => {
      for (const data of events) {
        if (data.trim() === "[DONE]") continue;
        acc.apply(JSON.parse(data) as RawChunk);
      }
      if (onProgress && Date.now() - lastProgress >= interval) {
        lastProgress = Date.now();
        onProgress(acc.progress());
      }
    };

    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle(parser.push(decoder.decode(value, { stream: true })));
    }
    handle(parser.push(decoder.decode()));
    handle(parser.flush());
  }
}

/** 재시도해도 되는 429인지 판단해 대기 시간을 돌려준다. 일일 한도 소진이면 undefined. */
function retryWaitMs(rateLimit: RateLimitSnapshot | undefined): number | undefined {
  if (rateLimit?.day?.remaining === 0) return undefined;
  if (rateLimit?.minute?.remaining === 0) return rateLimit.retryAfterMs ?? 60_000;
  return (rateLimit?.retryAfterMs ?? 1000) + 100;
}

function buildBody(request: CompletionRequest): Record<string, unknown> {
  const { settings } = request;
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: request.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
    temperature: settings.temperature,
    top_p: settings.topP,
    reasoning_effort: settings.reasoningEffort,
    chat_template_kwargs: { preserve_thinking: settings.preserveThinking },
  };
  if (settings.maxTokens !== undefined) body.max_tokens = settings.maxTokens;
  return body;
}

function toWireMessage(m: ChatMessage): Record<string, string> {
  const wire: Record<string, string> = { role: m.role, content: m.content };
  if (m.role === "assistant" && m.reasoning_content) wire.reasoning_content = m.reasoning_content;
  return wire;
}

/** 스트림 조각(또는 단일 JSON 응답)을 하나의 결과로 합친다. */
class Accumulator {
  private content = "";
  private reasoning = "";
  private finishReason?: string;
  private model?: string;
  private usage?: Usage;

  apply(chunk: RawChunk): void {
    if (chunk.result_code !== undefined && chunk.result_code >= 400) {
      throw new ExaoneApiError(chunk.description ?? `EXAONE API 오류 (result_code ${chunk.result_code})`, chunk.result_code);
    }
    if (chunk.error) {
      const msg = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "알 수 없는 오류");
      throw new ExaoneApiError(`EXAONE API 스트림 오류: ${msg}`, 500);
    }
    if (chunk.model) this.model = chunk.model;
    for (const choice of chunk.choices ?? []) {
      const part = choice.delta ?? choice.message;
      if (part?.reasoning_content) this.reasoning += part.reasoning_content;
      if (part?.content) this.content += part.content;
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    if (chunk.usage) this.usage = toUsage(chunk.usage);
  }

  progress(): CompletionProgress {
    return {
      phase: this.content.length > 0 ? "answer" : "reasoning",
      reasoningChars: this.reasoning.length,
      contentChars: this.content.length,
    };
  }

  toResult(elapsedMs: number, rateLimit: RateLimitSnapshot | undefined): CompletionResult {
    const result: CompletionResult = {
      // 문서상 content 앞에 "\n\n"이 붙을 수 있다.
      content: this.content.replace(/^\s+/, ""),
      reasoning: this.reasoning.trim(),
      elapsedMs,
    };
    if (this.finishReason) result.finishReason = this.finishReason;
    if (this.model) result.model = this.model;
    if (this.usage) result.usage = this.usage;
    if (rateLimit) result.rateLimit = rateLimit;
    return result;
  }
}

function toUsage(raw: RawUsage): Usage {
  const promptTokens = raw.prompt_tokens ?? 0;
  const completionTokens = raw.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: raw.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
  };
}

function describeHttpError(status: number, body: string, rateLimit?: RateLimitSnapshot): string {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as RawChunk & { message?: string; detail?: unknown };
    const fromError = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    detail = parsed.description ?? fromError ?? parsed.message ?? (parsed.detail ? JSON.stringify(parsed.detail) : detail);
  } catch {
    // JSON이 아니면 본문 앞부분을 그대로 쓴다.
  }

  const hint =
    status === 401 || status === 403
      ? " — API 키를 확인하세요 (EXAONE_API_KEY)."
      : status === 429
        ? rateLimit?.day?.remaining === 0
          ? ` — 일일 호출 한도(${rateLimit.day.limit ?? "?"}회)를 모두 썼습니다. 내일 다시 시도하세요.`
          : ` — 호출 한도를 넘었습니다.${rateLimit?.retryAfterMs !== undefined ? ` ${Math.ceil(rateLimit.retryAfterMs / 1000)}초 뒤 다시 시도하세요.` : ""}`
        : "";
  return `EXAONE API ${status}: ${detail || "(본문 없음)"}${hint}`;
}

function toNetworkError(error: unknown, timeout: AbortSignal, timeoutMs: number): ExaoneApiError {
  if (timeout.aborted) {
    return new ExaoneApiError(`EXAONE API 응답이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다 (EXAONE_TIMEOUT_MS).`, 0);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ExaoneApiError("요청이 취소되었습니다.", 0);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ExaoneApiError(`EXAONE API에 연결하지 못했습니다: ${message}`, 0);
}
