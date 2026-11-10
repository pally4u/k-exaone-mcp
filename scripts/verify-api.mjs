#!/usr/bin/env node
/**
 * 실제 EXAONE API로 이 서버가 기대하는 동작을 확인한다.
 *   npm run verify:api
 * 키는 환경변수 EXAONE_API_KEY 또는 프로젝트 루트의 .env 에서 읽으며, 출력에는 절대 남기지 않는다.
 * 결과는 콘솔 요약과 verify-report.json(.gitignore 대상)으로 남는다.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv() {
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv();
const KEY = process.env.EXAONE_API_KEY?.trim();
const BASE = (process.env.EXAONE_BASE_URL ?? "https://api.exaone.ai/v1").replace(/\/+$/, "");
const MODEL = process.env.EXAONE_MODEL ?? "k-exaone_v2.5";
if (!KEY) {
  console.error("EXAONE_API_KEY가 없습니다. .env.example 을 .env 로 복사해 키를 넣으세요.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = Number(process.env.VERIFY_GAP_MS ?? 1500); // 초당 1회 한도를 고려한 간격

function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    if (/^(set-cookie|authorization)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

async function call(path, { method = "POST", body, stream = false } = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body && { "Content-Type": "application/json" }),
      Accept: stream ? "text/event-stream" : "application/json",
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  if (!stream) {
    try {
      json = JSON.parse(text);
    } catch {
      /* JSON 아님 */
    }
  }
  return { status: res.status, headers: pickHeaders(res.headers), text, json, ms: Date.now() - started };
}

function parseSse(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((d) => d && d !== "[DONE]")
    .map((d) => {
      try {
        return JSON.parse(d);
      } catch {
        return { _unparsed: d };
      }
    });
}

const base = { model: MODEL, temperature: 1.0, top_p: 0.95 };
const report = { base: BASE, model: MODEL, at: new Date().toISOString(), checks: [] };

async function check(name, fn) {
  process.stdout.write(`• ${name} … `);
  try {
    const result = await fn();
    report.checks.push({ name, ...result });
    console.log(result.ok ? `OK  ${result.summary ?? ""}` : `NG  ${result.summary ?? ""}`);
  } catch (error) {
    report.checks.push({ name, ok: false, error: String(error) });
    console.log(`ERROR ${error}`);
  }
  await sleep(GAP_MS);
}

const short = (s, n = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// 1. 기본 호출: 응답 헤더(rate limit), usage
await check("non-stream 기본 호출 + 응답 헤더", async () => {
  const r = await call("/chat/completions", {
    body: { ...base, messages: [{ role: "user", content: "한 문장으로 자기소개 해줘." }], reasoning_effort: "low", stream: false },
  });
  const rl = Object.fromEntries(Object.entries(r.headers).filter(([k]) => /rate-limit|retry-after|request-id/i.test(k)));
  return {
    ok: r.status === 200,
    status: r.status,
    ms: r.ms,
    rateLimitHeaders: rl,
    allHeaderNames: Object.keys(r.headers),
    usage: r.json?.usage,
    answer: short(r.json?.choices?.[0]?.message?.content, 200),
    error: r.status !== 200 ? short(r.text, 300) : undefined,
    summary: `${r.status} ${r.ms}ms rate-limit 헤더 ${Object.keys(rl).length}개, usage=${JSON.stringify(r.json?.usage ?? null)}`,
  };
});

// 2. 스트리밍: 마지막 청크 usage, reasoning_content 분리
await check("stream + include_usage", async () => {
  const r = await call("/chat/completions", {
    stream: true,
    body: {
      ...base,
      messages: [{ role: "user", content: "1+1은?" }],
      reasoning_effort: "low",
      stream: true,
      stream_options: { include_usage: true },
    },
  });
  const chunks = parseSse(r.text);
  const usage = chunks.find((c) => c.usage)?.usage;
  const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content ?? "").join("");
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  return {
    ok: r.status === 200 && !!usage && content.length > 0,
    status: r.status,
    contentType: r.headers["content-type"],
    chunkCount: chunks.length,
    usage,
    reasoningChars: reasoning.length,
    answer: short(content),
    error: r.status !== 200 ? short(r.text, 300) : undefined,
    summary: `${r.status} chunks=${chunks.length} usage=${usage ? "있음" : "없음"} reasoning=${reasoning.length}자 answer="${short(content, 30)}"`,
  };
});

// 3. reasoning_effort 값별 허용 여부 (문서마다 medium 포함 여부가 다름)
for (const effort of ["low", "medium", "high", "max"]) {
  await check(`reasoning_effort=${effort}`, async () => {
    const r = await call("/chat/completions", {
      body: { ...base, messages: [{ role: "user", content: "2의 10제곱은? 숫자만." }], reasoning_effort: effort, max_tokens: 4096, stream: false },
    });
    const u = r.json?.usage;
    return {
      ok: r.status === 200,
      status: r.status,
      ms: r.ms,
      reasoningTokens: u?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens,
      answer: short(r.json?.choices?.[0]?.message?.content),
      error: r.status !== 200 ? short(r.text, 300) : undefined,
      summary: `${r.status} ${r.ms}ms reasoning_tokens=${u?.reasoning_tokens ?? "?"} answer="${short(r.json?.choices?.[0]?.message?.content, 20)}"`,
    };
  });
}

// 4. 멀티턴 + preserve_thinking + assistant.reasoning_content 전달
await check("멀티턴 preserve_thinking + reasoning_content", async () => {
  const r = await call("/chat/completions", {
    body: {
      ...base,
      reasoning_effort: "low",
      stream: false,
      chat_template_kwargs: { preserve_thinking: true },
      messages: [
        { role: "user", content: "내가 좋아하는 숫자는 7이야. 기억해." },
        { role: "assistant", content: "네, 7을 기억할게요.", reasoning_content: "User says favorite number is 7." },
        { role: "user", content: "내가 좋아하는 숫자에 3을 곱하면?" },
      ],
    },
  });
  const answer = r.json?.choices?.[0]?.message?.content ?? "";
  return {
    ok: r.status === 200 && answer.includes("21"),
    status: r.status,
    answer: short(answer),
    error: r.status !== 200 ? short(r.text, 300) : undefined,
    summary: `${r.status} answer="${short(answer, 40)}"`,
  };
});

// 5. Tool calling (Cline·Cherry Studio 등에서 엑시온을 에이전트로 쓸 때 필요)
await check("tool calling (tools 파라미터)", async () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file from the user's project",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ];
  const r = await call("/chat/completions", {
    body: {
      ...base,
      reasoning_effort: "low",
      stream: false,
      tools,
      tool_choice: "auto",
      messages: [{ role: "user", content: "README.md 파일을 읽어서 요약해줘. 반드시 도구를 사용해." }],
    },
  });
  const msg = r.json?.choices?.[0]?.message;
  const calls = msg?.tool_calls ?? [];
  return {
    ok: r.status === 200 && calls.length > 0,
    status: r.status,
    finishReason: r.json?.choices?.[0]?.finish_reason,
    toolCalls: calls,
    content: short(msg?.content, 200),
    error: r.status !== 200 ? short(r.text, 300) : undefined,
    summary: `${r.status} finish=${r.json?.choices?.[0]?.finish_reason} tool_calls=${calls.length} ${calls[0] ? `${calls[0].function?.name}(${calls[0].function?.arguments})` : ""}`,
  };
});

// 6. 도구 결과를 돌려준 뒤 최종 답변까지 이어지는지
await check("tool 결과 → 최종 답변", async () => {
  const r = await call("/chat/completions", {
    body: {
      ...base,
      reasoning_effort: "low",
      stream: false,
      tools: [
        {
          type: "function",
          function: { name: "get_time", description: "현재 시각", parameters: { type: "object", properties: {} } },
        },
      ],
      messages: [
        { role: "user", content: "지금 몇 시야?" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "2026-11-10T15:42:00+09:00" },
      ],
    },
  });
  const answer = r.json?.choices?.[0]?.message?.content ?? "";
  return {
    ok: r.status === 200 && /15|3시/.test(answer),
    status: r.status,
    answer: short(answer),
    error: r.status !== 200 ? short(r.text, 300) : undefined,
    summary: `${r.status} answer="${short(answer, 40)}"`,
  };
});

// 7. 사용량·모델 조회용 엔드포인트가 있는지 (문서에는 없음)
for (const path of ["/models", "/usage"]) {
  await check(`GET ${path}`, async () => {
    const r = await call(path, { method: "GET" });
    return { ok: r.status === 200, status: r.status, body: short(r.text, 300), summary: `${r.status} ${short(r.text, 60)}` };
  });
}

writeFileSync(join(root, "verify-report.json"), JSON.stringify(report, null, 2));
const passed = report.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${report.checks.length} 통과 · 상세: verify-report.json`);
