import type { RateLimitSnapshot, RateLimitWindow } from "../domain/model.js";

interface HeaderSource {
  get(name: string): string | null;
}

const WINDOWS = ["second", "minute", "day"] as const;

function toNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 응답 헤더에서 호출 한도를 읽는다. 관련 헤더가 하나도 없으면 undefined.
 * https://docs.exaone.ai/ko/docs/rate-limits
 */
export function parseRateLimitHeaders(headers: HeaderSource, now = new Date()): RateLimitSnapshot | undefined {
  const snapshot: RateLimitSnapshot = { observedAt: now };
  let found = false;

  for (const window of WINDOWS) {
    const limit = toNumber(headers.get(`x-${window}-rate-limit`));
    const remaining = toNumber(headers.get(`x-${window}-rate-limit-remaining`));
    if (limit !== undefined || remaining !== undefined) {
      const w: RateLimitWindow = {};
      if (limit !== undefined) w.limit = limit;
      if (remaining !== undefined) w.remaining = remaining;
      snapshot[window] = w;
      found = true;
    }
  }

  const retryAfterMs = toNumber(headers.get("retry-after-ms"));
  const retryAfterSec = toNumber(headers.get("retry-after"));
  if (retryAfterMs !== undefined) snapshot.retryAfterMs = retryAfterMs;
  else if (retryAfterSec !== undefined) snapshot.retryAfterMs = retryAfterSec * 1000;
  if (snapshot.retryAfterMs !== undefined) found = true;

  const requestId = headers.get("x-request-id");
  if (requestId) snapshot.requestId = requestId;

  return found ? snapshot : undefined;
}
