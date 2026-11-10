import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ExaoneService } from "../src/application/exaoneService.js";
import { DEFAULTS, loadConfig, maskKey } from "../src/config.js";
import { AttachmentError, ConfigError, ConversationNotFoundError } from "../src/domain/errors.js";
import type { CompletionRequest, CompletionResult } from "../src/domain/model.js";
import type { ChatCompletionPort } from "../src/domain/ports.js";
import { UsageLedger } from "../src/domain/usageLedger.js";
import { InMemoryConversationRepository } from "../src/infrastructure/inMemoryConversationRepository.js";
import { LocalFileReader } from "../src/infrastructure/localFileReader.js";

class FakeClient implements ChatCompletionPort {
  readonly requests: CompletionRequest[] = [];
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const n = this.requests.length;
    return {
      content: `answer ${n}`,
      reasoning: `reasoning ${n}`,
      finishReason: "stop",
      model: "k-exaone_v2.5",
      usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 3, totalTokens: 15 },
      rateLimit: { minute: { limit: 60, remaining: 60 - n }, observedAt: new Date() },
      elapsedMs: 1,
    };
  }
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "k-exaone-mcp-"));
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "big.txt"), "x".repeat(3000));
  await writeFile(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
});

function makeService(client = new FakeClient(), preserveThinking = true) {
  const ledger = new UsageLedger();
  const service = new ExaoneService({
    client,
    conversations: new InMemoryConversationRepository(10),
    files: new LocalFileReader(dir),
    ledger,
    settings: { model: "k-exaone_v2.5", reasoningEffort: "high", temperature: 1, topP: 0.95, preserveThinking },
    attachmentLimits: { maxFileBytes: 2048, maxTotalBytes: 4096, maxFiles: 3 },
    maxTurnsPerConversation: 2,
  });
  return { service, client, ledger };
}

describe("ExaoneService.ask", () => {
  it("새 대화를 만들고 system·질문을 보낸다", async () => {
    const { service, client } = makeService();
    const out = await service.ask({ prompt: "hi", system: "be brief", reasoningEffort: "low" });

    expect(out.turn).toBe(1);
    expect(out.result.content).toBe("answer 1");
    expect(client.requests[0]!.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    expect(client.requests[0]!.settings.reasoningEffort).toBe("low");
  });

  it("conversation_id로 이어 묻으면 이전 턴과 추론을 함께 보낸다", async () => {
    const { service, client } = makeService();
    const first = await service.ask({ prompt: "q1", system: "sys" });
    const second = await service.ask({ prompt: "q2", conversationId: first.conversationId });

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.turn).toBe(2);
    expect(client.requests[1]!.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "answer 1", reasoning_content: "reasoning 1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("preserve_thinking=false면 이전 추론을 보관하지 않는다", async () => {
    const { service, client } = makeService(new FakeClient(), false);
    const first = await service.ask({ prompt: "q1" });
    await service.ask({ prompt: "q2", conversationId: first.conversationId });
    expect(client.requests[1]!.messages[1]).toEqual({ role: "assistant", content: "answer 1" });
  });

  it("최대 턴 수를 넘으면 오래된 턴을 버린다", async () => {
    const { service, client } = makeService();
    const first = await service.ask({ prompt: "q1" });
    await service.ask({ prompt: "q2", conversationId: first.conversationId });
    await service.ask({ prompt: "q3", conversationId: first.conversationId });
    await service.ask({ prompt: "q4", conversationId: first.conversationId });
    // 보관 한도 2턴: 네 번째 요청에는 직전 두 턴(q2, q3)만 남는다.
    const contents = client.requests[3]!.messages.map((m) => m.content);
    expect(contents).toEqual(["q2", "answer 2", "q3", "answer 3", "q4"]);
  });

  it("없는 conversation_id는 오류", async () => {
    const { service } = makeService();
    await expect(service.ask({ prompt: "x", conversationId: "nope" })).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("첨부 파일을 읽어 질문 뒤에 붙인다(상대 경로는 작업 폴더 기준)", async () => {
    const { service, client } = makeService();
    const out = await service.ask({ prompt: "review", files: ["a.ts"] });
    const content = client.requests[0]!.messages.at(-1)!.content;
    expect(content).toContain(`<file path="${join(dir, "a.ts")}">`);
    expect(content).toContain("export const a = 1;");
    expect(out.attachedFiles).toEqual([join(dir, "a.ts")]);
  });

  it("바이너리·없는 파일·한도 초과를 거부한다", async () => {
    const { service } = makeService();
    await expect(service.ask({ prompt: "x", files: ["bin.dat"] })).rejects.toBeInstanceOf(AttachmentError);
    await expect(service.ask({ prompt: "x", files: ["missing.txt"] })).rejects.toBeInstanceOf(AttachmentError);
    await expect(service.ask({ prompt: "x", files: ["big.txt"] })).rejects.toThrow(/파일당 한도/);
    await expect(service.ask({ prompt: "x", files: ["a.ts", "a.ts", "a.ts", "a.ts"] })).rejects.toThrow(/최대 3개/);
  });

  it("누적 사용량과 마지막 rate limit을 기록한다", async () => {
    const { service, ledger } = makeService();
    await service.ask({ prompt: "1" });
    await service.ask({ prompt: "2" });
    const snap = ledger.snapshot();
    expect(snap.calls).toBe(2);
    expect(snap.usage.totalTokens).toBe(30);
    expect(snap.lastRateLimit?.minute?.remaining).toBe(58);
  });
});

describe("ExaoneService.status", () => {
  it("ping=false면 API를 호출하지 않는다", async () => {
    const { service, client } = makeService();
    const status = await service.status(false);
    expect(client.requests).toHaveLength(0);
    expect(status.ping).toBeUndefined();
  });

  it("ping=true면 low 강도로 작은 요청을 보낸다", async () => {
    const { service, client } = makeService();
    const status = await service.status(true);
    expect(status.ping?.ok).toBe(true);
    expect(client.requests[0]!.settings.reasoningEffort).toBe("low");
  });
});

describe("loadConfig", () => {
  it("기본값은 문서 권장값을 따른다", () => {
    const c = loadConfig({}, "/work");
    expect(c).toMatchObject({
      baseUrl: DEFAULTS.baseUrl,
      model: "k-exaone_v2.5",
      reasoningEffort: "high",
      temperature: 1,
      topP: 0.95,
      preserveThinking: true,
      workDir: "/work",
    });
    expect(c.apiKey).toBeUndefined();
  });

  it("환경변수로 덮어쓴다", () => {
    const c = loadConfig({
      EXAONE_API_KEY: " key ",
      EXAONE_BASE_URL: "http://localhost:8000/v1/",
      EXAONE_REASONING_EFFORT: "MAX",
      EXAONE_PRESERVE_THINKING: "false",
      EXAONE_MAX_TOKENS: "4096",
      EXAONE_MAX_FILE_KB: "10",
    });
    expect(c).toMatchObject({
      apiKey: "key",
      baseUrl: "http://localhost:8000/v1",
      reasoningEffort: "max",
      preserveThinking: false,
      maxTokens: 4096,
      maxFileBytes: 10240,
    });
  });

  it("잘못된 값은 ConfigError", () => {
    expect(() => loadConfig({ EXAONE_REASONING_EFFORT: "ultra" })).toThrow(ConfigError);
    expect(() => loadConfig({ EXAONE_TOP_P: "2" })).toThrow(ConfigError);
    expect(() => loadConfig({ EXAONE_PRESERVE_THINKING: "maybe" })).toThrow(ConfigError);
  });

  it("키는 끝 4자리만 보인다", () => {
    expect(maskKey("abcdefghijkl1234")).toBe("****1234");
    expect(maskKey("short")).toBe("****");
    expect(maskKey(undefined)).toBe("(설정 안 됨)");
  });
});
