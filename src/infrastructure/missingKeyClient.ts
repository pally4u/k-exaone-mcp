import { ConfigError } from "../domain/errors.js";
import type { CompletionResult } from "../domain/model.js";
import type { ChatCompletionPort } from "../domain/ports.js";

/**
 * API 키 없이 서버가 시작된 경우에 쓰는 클라이언트.
 * 서버를 죽이는 대신, 도구 호출 시 설정 방법을 알려 준다.
 */
export class MissingKeyClient implements ChatCompletionPort {
  complete(): Promise<CompletionResult> {
    return Promise.reject(
      new ConfigError(
        "EXAONE_API_KEY가 설정되지 않았습니다. MCP 클라이언트 설정의 env 항목에 EXAONE_API_KEY를 넣고 클라이언트를 다시 시작하세요. " +
          "키 발급: https://docs.exaone.ai/ko/docs/authentication",
      ),
    );
  }
}
