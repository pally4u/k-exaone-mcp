/** 테스트용 SSE 응답을 만든다. chunks는 네트워크 조각을 흉내 내기 위해 임의 위치에서 잘라도 된다. */
export function sseResponse(chunks: string[], headers: Record<string, string> = {}, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

export function sseEvents(payloads: unknown[]): string {
  return payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join("");
}

/** 문자열을 size 글자씩 잘라 네트워크 조각처럼 만든다. */
export function splitEvery(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

export const STREAM_FIXTURE = [
  { id: "x", model: "k-exaone_v2.5", choices: [{ delta: { content: "", role: "assistant" }, index: 0 }] },
  { id: "x", model: "k-exaone_v2.5", choices: [{ delta: { reasoning_content: "We need " }, index: 0 }] },
  { id: "x", model: "k-exaone_v2.5", choices: [{ delta: { reasoning_content: "to greet." }, index: 0 }] },
  { id: "x", model: "k-exaone_v2.5", choices: [{ delta: { content: "\n\n안녕하세요" }, index: 0 }] },
  { id: "x", model: "k-exaone_v2.5", choices: [{ delta: { content: "! 😊" }, index: 0 }] },
  { id: "x", model: "k-exaone_v2.5", choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
  {
    id: "x",
    model: "k-exaone_v2.5",
    choices: [],
    usage: { completion_tokens: 234, prompt_tokens: 22, total_tokens: 256, reasoning_tokens: 216 },
  },
  "[DONE]",
];

export const RATE_HEADERS = {
  "x-request-id": "req-123",
  "x-second-rate-limit": "1",
  "x-second-rate-limit-remaining": "0",
  "x-minute-rate-limit": "60",
  "x-minute-rate-limit-remaining": "59",
  "x-day-rate-limit": "86400",
  "x-day-rate-limit-remaining": "86300",
};
