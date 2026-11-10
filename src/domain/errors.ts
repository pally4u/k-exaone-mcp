import type { RateLimitSnapshot } from "./model.js";

/** 도메인 오류. 표현 계층이 사용자에게 보여 줄 메시지로 변환한다. */

export class ExaoneApiError extends Error {
  override readonly name = "ExaoneApiError";

  constructor(
    message: string,
    /** HTTP 상태 코드. 네트워크 오류·시간 초과는 0 */
    readonly status: number,
    readonly rateLimit?: RateLimitSnapshot,
  ) {
    super(message);
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class AttachmentError extends Error {
  override readonly name = "AttachmentError";
}

export class ConversationNotFoundError extends Error {
  override readonly name = "ConversationNotFoundError";

  constructor(readonly conversationId: string) {
    super(`대화를 찾을 수 없습니다: ${conversationId} (서버가 재시작되었거나 오래되어 정리되었을 수 있습니다)`);
  }
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}
