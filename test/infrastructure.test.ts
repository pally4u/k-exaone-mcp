import { describe, expect, it, vi } from "vitest";
import { Conversation } from "../src/domain/conversation.js";
import { ExaoneApiError } from "../src/domain/errors.js";
import type { CompletionRequest } from "../src/domain/model.js";
import { ExaoneHttpClient } from "../src/infrastructure/exaoneHttpClient.js";
import { InMemoryConversationRepository } from "../src/infrastructure/inMemoryConversationRepository.js";
import { parseRateLimitHeaders } from "../src/infrastructure/rateLimitHeaders.js";
import { SseParser } from "../src/infrastructure/sseParser.js";
import { RATE_HEADERS, sseEvents, sseResponse, splitEvery, STREAM_FIXTURE } from "./helpers.js";

const request: CompletionRequest = {
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1", reasoning_content: "r1" },
    { role: "user", content: "q2" },
  ],
  settings: { model: "k-exaone_v2.5", reasoningEffort: "high", temperature: 1, topP: 0.95, preserveThinking: true },
};

describe("SseParser", () => {
  it("줄 중간에서 끊긴 청크도 완성된 이벤트만 내보낸다", () => {
    const parser = new SseParser();
    const text = sseEvents([{ a: 1 }, { b: "한글" }, "[DONE]"]);
    const events = splitEvery(text, 3).flatMap((c) => parser.push(c));
    events.push(...parser.flush());
    expect(events).toEqual(['{"a":1}', '{"b":"한글"}', "[DONE]"]);
  });

  it("CRLF와 주석 줄을 처리한다", () => {
    const parser = new SseParser();
    const events = parser.push(": keep-alive\r\ndata: {\"x\":1}\r\n\r\n");
    expect(events).toEqual(['{"x":1}']);
  });
});

describe("parseRateLimitHeaders", () => {
  it("문서에 정의된 헤더를 읽는다", () => {
    const snap = parseRateLimitHeaders(new Headers({ ...RATE_HEADERS, "retry-after": "1", "retry-after-ms": "630" }));
    expect(snap).toMatchObject({
      second: { limit: 1, remaining: 0 },
      minute: { limit: 60, remaining: 59 },
      day: { limit: 86400, remaining: 86300 },
      retryAfterMs: 630,
      requestId: "req-123",
    });
  });

  it("관련 헤더가 없으면 undefined", () => {
    expect(parseRateLimitHeaders(new Headers({ "x-request-id": "only-id" }))).toBeUndefined();
  });
});

describe("ExaoneHttpClient", () => {
  it("스트림을 합쳐 답변·추론·usage·rate limit을 돌려준다", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(splitEvery(sseEvents(STREAM_FIXTURE), 7), RATE_HEADERS));
    const client = new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://api.example/v1/", timeoutMs: 5000, fetchImpl });

    const result = await client.complete(request);

    expect(result.content).toBe("안녕하세요! 😊");
    expect(result.reasoning).toBe("We need to greet.");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 22, completionTokens: 234, reasoningTokens: 216, totalTokens: 256 });
    expect(result.rateLimit?.minute).toEqual({ limit: 60, remaining: 59 });
  });

  it("문서 권장 파라미터와 이전 추론을 요청 본문에 넣는다", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sseResponse([sseEvents(STREAM_FIXTURE)]));
    const client = new ExaoneHttpClient({ apiKey: "secret", baseUrl: "https://api.example/v1", timeoutMs: 5000, fetchImpl });

    await client.complete({ ...request, settings: { ...request.settings, maxTokens: 100 } });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example/v1/chat/completions");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model: "k-exaone_v2.5",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 1,
      top_p: 0.95,
      reasoning_effort: "high",
      max_tokens: 100,
      chat_template_kwargs: { preserve_thinking: true },
    });
    expect(body.messages[2]).toEqual({ role: "assistant", content: "a1", reasoning_content: "r1" });
    expect(body.messages[1]).toEqual({ role: "user", content: "q1" });
  });

  const tooMany = (extra: Record<string, string>) =>
    new Response(JSON.stringify({ result_code: 429, description: "Too many requests" }), {
      status: 429,
      headers: { "content-type": "application/json", ...RATE_HEADERS, ...extra },
    });

  it("초당 한도 429는 기다렸다가 자동으로 다시 보낸다", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tooMany({ "retry-after-ms": "630" }))
      .mockResolvedValueOnce(sseResponse([sseEvents(STREAM_FIXTURE)], RATE_HEADERS));
    const sleep = vi.fn(async () => undefined);
    const client = new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://api.example/v1", timeoutMs: 5000, fetchImpl, sleep });

    const result = await client.complete(request);
    expect(result.content).toBe("안녕하세요! 😊");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(730, expect.anything());
  });

  it("일일 한도 소진 429는 재시도하지 않고 안내한다", async () => {
    const fetchImpl = vi.fn(async () => tooMany({ "x-day-rate-limit": "100", "x-day-rate-limit-remaining": "0" }));
    const sleep = vi.fn(async () => undefined);
    const client = new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://api.example/v1", timeoutMs: 5000, fetchImpl, sleep });

    await expect(client.complete(request)).rejects.toThrow(/일일 호출 한도\(100회\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("재시도 횟수를 넘긴 429는 retry-after와 함께 ExaoneApiError로 바꾼다", async () => {
    const fetchImpl = vi.fn(async () => tooMany({ "retry-after": "2" }));
    const client = new ExaoneHttpClient({
      apiKey: "k",
      baseUrl: "https://api.example/v1",
      timeoutMs: 5000,
      fetchImpl,
      sleep: async () => undefined,
    });

    const error = await client.complete(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExaoneApiError);
    const apiError = error as ExaoneApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.message).toContain("Too many requests");
    expect(apiError.message).toContain("2초 뒤");
    expect(apiError.rateLimit?.requestId).toBe("req-123");
  });

  it("401은 API 키 안내를 붙인다", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"result_code":401,"description":"Invalid API key"}', { status: 401 }));
    const client = new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://api.example/v1", timeoutMs: 5000, fetchImpl });
    await expect(client.complete(request)).rejects.toThrow(/EXAONE_API_KEY/);
  });

  it("스트림 중간의 오류 이벤트를 오류로 처리한다", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([sseEvents([STREAM_FIXTURE[1], { result_code: 500, description: "temporary issue" }])]),
    );
    const client = new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://api.example/v1", timeoutMs: 5000, fetchImpl });
    await expect(client.complete(request)).rejects.toThrow("temporary issue");
  });

  it("stream이 아닌 JSON 응답도 처리한다", async () => {
    const json = {
      model: "k-exaone_v2.5",
      choices: [{ finish_reason: "stop", message: { content: "\n\nHello", reasoning_content: "think" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, reasoning_tokens: 1 },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } }));
    const client = new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://api.example/v1", timeoutMs: 5000, fetchImpl });
    const result = await client.complete(request);
    expect(result.content).toBe("Hello");
    expect(result.usage?.reasoningTokens).toBe(1);
  });

  it("시간 초과를 알기 쉬운 메시지로 바꾼다", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const client = new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://api.example/v1", timeoutMs: 50, fetchImpl });
    await expect(client.complete(request)).rejects.toThrow(/EXAONE_TIMEOUT_MS/);
  });
});

describe("InMemoryConversationRepository", () => {
  it("용량을 넘으면 가장 오래 쓰지 않은 대화를 지운다", () => {
    const repo = new InMemoryConversationRepository(2);
    const a = new Conversation("a", undefined, 5);
    const b = new Conversation("b", undefined, 5);
    const c = new Conversation("c", undefined, 5);
    repo.save(a);
    repo.save(b);
    repo.save(a); // a를 최근 사용으로
    repo.save(c);
    expect(repo.find("a")).toBe(a);
    expect(repo.find("b")).toBeUndefined();
    expect(repo.count()).toBe(2);
  });
});
