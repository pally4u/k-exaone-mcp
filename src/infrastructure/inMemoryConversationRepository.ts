import type { Conversation } from "../domain/conversation.js";
import type { ConversationRepository } from "../domain/ports.js";

/** 프로세스 메모리에 대화를 보관한다. 개수를 넘으면 가장 오래 쓰지 않은 대화부터 지운다. */
export class InMemoryConversationRepository implements ConversationRepository {
  private readonly items = new Map<string, Conversation>();

  constructor(private readonly capacity: number) {}

  find(id: string): Conversation | undefined {
    return this.items.get(id);
  }

  save(conversation: Conversation): void {
    // Map은 삽입 순서를 유지하므로, 다시 넣으면 "최근 사용"이 된다.
    this.items.delete(conversation.id);
    this.items.set(conversation.id, conversation);
    while (this.items.size > this.capacity) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  count(): number {
    return this.items.size;
  }
}
