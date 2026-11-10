#!/usr/bin/env node
/**
 * 빌드된 서버(dist/index.js)를 실제 MCP 클라이언트처럼 stdio로 띄워 끝까지 확인한다.
 *   npm run build && npm run smoke
 * API를 2회 호출한다(첨부 질문 1회 + 후속 질문 1회). 키는 .env 또는 환경변수에서 읽는다.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
const dotenv = join(root, ".env");
if (existsSync(dotenv)) {
  for (const line of readFileSync(dotenv, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith("#") && m[2] && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js")],
  env: { ...env, EXAONE_REASONING_EFFORT: env.EXAONE_REASONING_EFFORT ?? "low" },
  stderr: "inherit",
});
const client = new Client({ name: "k-exaone-mcp-smoke", version: "1.0.0" });
await client.connect(transport);

const text = (r) => r.content.map((c) => c.text).join("\n");

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const first = await client.callTool(
  {
    name: "ask_exaone",
    arguments: {
      prompt: "첨부한 package.json을 보고 이 프로젝트가 무엇인지 한 문장으로 설명해줘.",
      files: [join(root, "package.json")],
    },
  },
  undefined,
  { timeout: 600_000, onprogress: (p) => process.stderr.write(`  progress: ${p.message ?? p.progress}\n`) },
);
console.log("\n=== ask_exaone #1 ===\n" + text(first));
if (first.isError) process.exit(1);

const conversationId = text(first).match(/conversation_id: ([0-9a-f-]{36})/)?.[1];
const second = await client.callTool(
  { name: "ask_exaone", arguments: { prompt: "방금 설명을 영어로 바꿔줘.", conversation_id: conversationId } },
  undefined,
  { timeout: 600_000 },
);
console.log("\n=== ask_exaone #2 (follow-up) ===\n" + text(second));

const status = await client.callTool({ name: "exaone_status", arguments: { ping: false } });
console.log("\n=== exaone_status ===\n" + text(status));

await client.close();
process.exit(second.isError ? 1 : 0);
