import { addUsage, emptyUsage, type RateLimitSnapshot, type Usage } from "./model.js";

/** 서버 프로세스가 살아 있는 동안의 누적 사용량과 마지막으로 본 호출 한도. */
export class UsageLedger {
  private total: Usage = emptyUsage();
  private calls = 0;
  private failures = 0;
  private lastRateLimit?: RateLimitSnapshot;
  readonly startedAt = new Date();

  recordSuccess(usage: Usage | undefined, rateLimit: RateLimitSnapshot | undefined): void {
    this.calls += 1;
    if (usage) this.total = addUsage(this.total, usage);
    if (rateLimit) this.lastRateLimit = rateLimit;
  }

  recordFailure(rateLimit?: RateLimitSnapshot): void {
    this.calls += 1;
    this.failures += 1;
    if (rateLimit) this.lastRateLimit = rateLimit;
  }

  snapshot() {
    return {
      calls: this.calls,
      failures: this.failures,
      usage: { ...this.total },
      lastRateLimit: this.lastRateLimit,
      startedAt: this.startedAt,
    };
  }
}

export type UsageSummary = ReturnType<UsageLedger["snapshot"]>;
