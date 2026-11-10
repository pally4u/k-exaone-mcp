import type { Conversation } from "./conversation.js";
import type { CompletionProgress, CompletionRequest, CompletionResult } from "./model.js";

/**
 * 응용 계층이 인프라에 접근할 때 쓰는 인터페이스.
 * 구현은 infrastructure/ 에 있다.
 */

export interface ChatCompletionPort {
  complete(
    request: CompletionRequest,
    options?: { signal?: AbortSignal; onProgress?: (p: CompletionProgress) => void },
  ): Promise<CompletionResult>;
}

export interface ConversationRepository {
  find(id: string): Conversation | undefined;
  save(conversation: Conversation): void;
  count(): number;
}

export interface TextFileReader {
  /**
   * 파일을 읽어 바이트 그대로 돌려준다. 경로 해석과 존재 확인은 구현 책임.
   * maxBytes를 넘는 파일은 읽기 전에 AttachmentError로 거부한다.
   */
  read(path: string, maxBytes: number): Promise<{ resolvedPath: string; bytes: Uint8Array }>;
}
