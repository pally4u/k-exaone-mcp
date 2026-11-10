import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { ExaoneService } from "../src/application/exaoneService.js";
import { UsageLedger } from "../src/domain/usageLedger.js";
import { ExaoneHttpClient } from "../src/infrastructure/exaoneHttpClient.js";
import { InMemoryConversationRepository } from "../src/infrastructure/inMemoryConversationRepository.js";
import { LocalFileReader } from "../src/infrastructure/localFileReader.js";
import { MissingKeyClient } from "../src/infrastructure/missingKeyClient.js";
import { createServer } from "../src/presentation/server.js";
import { RATE_HEADERS, sseEvents, sseResponse, STREAM_FIXTURE } from "./helpers.js";

/** MCP 클라이언트 → 서버 → (가짜 fetch) 까지 실제 프로토콜로 연결해 확인한다. */
async function connect(client: ExaoneHttpClient | MissingKeyClient) {
  const service = new ExaoneService({
    client,
    conversations: new InMemoryConversationRepository(10),
    files: new LocalFileReader(process.cwd()),
    ledger: new UsageLedger(),
    settings: { model: "k-exaone_v2.5", reasoningEffort: "high", temperature: 1, topP: 0.95, preserveThinking: true },
    attachmentLimits: { maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxFiles: 5 },
    maxTurnsPerConversation: 5,
  });
  const server = createServer(service, {
    name: "k-exaone-mcp",
    version: "0.0.0-test",
    maskedKey: "****test",
    defaultEffort: "high",
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
    workDir: process.cwd(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test", version: "1.0.0" });
  await mcp.connect(clientTransport);
  return mcp;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join("\n");
}

describe("MCP server", () => {
  it("두 도구를 노출한다", async () => {
    const mcp = await connect(new MissingKeyClient());
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ask_exaone", "exaone_status"]);
    const ask = tools.find((t) => t.name === "ask_exaone")!;
    expect(Object.keys(ask.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["prompt", "files", "conversation_id", "reasoning_effort", "include_reasoning"]),
    );
  });

  it("ask_exaone: 답변 뒤에 사용량·rate limit 꼬리말을 붙인다", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([sseEvents(STREAM_FIXTURE)], RATE_HEADERS));
    const mcp = await connect(new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://x/v1", timeoutMs: 5000, fetchImpl }));

    const result = await mcp.callTool({ name: "ask_exaone", arguments: { prompt: "안녕", include_reasoning: true } });
    const text = textOf(result);

    expect(result.isError).toBeFalsy();
    expect(text).toContain("안녕하세요! 😊");
    expect(text).toContain("<exaone_reasoning>\nWe need to greet.\n</exaone_reasoning>");
    expect(text).toMatch(/conversation_id: [0-9a-f-]{36} \(turn 1\)/);
    expect(text).toContain("tokens: in 22 / out 234 (reasoning 216)");
    expect(text).toContain("rate limit remaining: second 0/1, minute 59/60, day 86300/86400");
  });

  it("exaone_status: 키 원문 없이 누적 사용량을 보여 준다", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([sseEvents(STREAM_FIXTURE)], RATE_HEADERS));
    const mcp = await connect(new ExaoneHttpClient({ apiKey: "k", baseUrl: "https://x/v1", timeoutMs: 5000, fetchImpl }));

    await mcp.callTool({ name: "ask_exaone", arguments: { prompt: "1" } });
    const text = textOf(await mcp.callTool({ name: "exaone_status", arguments: { ping: true } }));

    expect(text).toContain("API key: ****test");
    expect(text).toContain("호출: 2회 (실패 0회)");
    expect(text).toContain("결과: 성공");
    expect(text).toContain("x-request-id: req-123");
  });

  it("키가 없으면 isError와 설정 안내를 돌려준다", async () => {
    const mcp = await connect(new MissingKeyClient());
    const result = await mcp.callTool({ name: "ask_exaone", arguments: { prompt: "hi" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("EXAONE_API_KEY가 설정되지 않았습니다");
  });

  it("잘못된 reasoning_effort는 거부한다", async () => {
    const mcp = await connect(new MissingKeyClient());
    const result = await mcp.callTool({ name: "ask_exaone", arguments: { prompt: "hi", reasoning_effort: "ultra" } });
    expect(result.isError).toBe(true);
  });
});
