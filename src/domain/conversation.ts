import type { ChatMessage } from "./model.js";

/**
 * 하나의 대화 스레드. 후속 질문 시 이전 턴을 그대로 다시 보내기 위해 보관한다.
 * system 메시지는 첫 요청에서 정한 것을 유지한다.
 */
export class Conversation {
  private readonly turns: ChatMessage[] = [];
  updatedAt: Date;

  constructor(
    readonly id: string,
    readonly system: string | undefined,
    readonly maxTurns: number,
  ) {
    this.updatedAt = new Date();
  }

  /** 다음 요청에 보낼 전체 메시지(system + 이전 턴 + 새 user 메시지). */
  buildMessages(userContent: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (this.system) messages.push({ role: "system", content: this.system });
    messages.push(...this.turns, { role: "user", content: userContent });
    return messages;
  }

  recordExchange(userContent: string, assistant: ChatMessage): void {
    this.turns.push({ role: "user", content: userContent }, assistant);
    // user/assistant 한 쌍이 한 턴. 오래된 턴부터 버린다.
    const overflow = this.turns.length - this.maxTurns * 2;
    if (overflow > 0) this.turns.splice(0, overflow);
    this.updatedAt = new Date();
  }

  get turnCount(): number {
    return this.turns.length / 2;
  }
}
