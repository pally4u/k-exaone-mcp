#!/usr/bin/env node
/**
 * 진입점(composition root): 설정을 읽고 계층별 구현을 조립해 stdio MCP 서버를 띄운다.
 * stdout은 MCP 프로토콜 전용이므로 로그는 반드시 stderr로 쓴다.
 */
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ExaoneService } from "./application/exaoneService.js";
import { loadConfig, maskKey } from "./config.js";
import { UsageLedger } from "./domain/usageLedger.js";
import { ExaoneHttpClient } from "./infrastructure/exaoneHttpClient.js";
import { InMemoryConversationRepository } from "./infrastructure/inMemoryConversationRepository.js";
import { LocalFileReader } from "./infrastructure/localFileReader.js";
import { MissingKeyClient } from "./infrastructure/missingKeyClient.js";
import { createServer } from "./presentation/server.js";

const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const config = loadConfig();

  const client = config.apiKey
    ? new ExaoneHttpClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs })
    : new MissingKeyClient();

  const service = new ExaoneService({
    client,
    conversations: new InMemoryConversationRepository(config.maxConversations),
    files: new LocalFileReader(config.workDir),
    ledger: new UsageLedger(),
    settings: {
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      temperature: config.temperature,
      topP: config.topP,
      preserveThinking: config.preserveThinking,
      ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
    },
    attachmentLimits: { maxFileBytes: config.maxFileBytes, maxTotalBytes: config.maxTotalBytes, maxFiles: config.maxFiles },
    maxTurnsPerConversation: config.maxTurnsPerConversation,
  });

  const server = createServer(service, {
    name: pkg.name,
    version: pkg.version,
    maskedKey: maskKey(config.apiKey),
    defaultEffort: config.reasoningEffort,
    maxFileBytes: config.maxFileBytes,
    maxTotalBytes: config.maxTotalBytes,
    workDir: config.workDir,
  });

  await server.connect(new StdioServerTransport());
  console.error(
    `[k-exaone-mcp] v${pkg.version} ready · model=${config.model} · effort=${config.reasoningEffort} · key=${maskKey(config.apiKey)}`,
  );
}

main().catch((error: unknown) => {
  console.error(`[k-exaone-mcp] 시작 실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
