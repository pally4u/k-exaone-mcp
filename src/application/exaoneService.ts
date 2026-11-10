import { randomUUID } from "node:crypto";
import { assertWithinLimits, composePrompt, looksBinary, type Attachment, type AttachmentLimits } from "../domain/attachments.js";
import { Conversation } from "../domain/conversation.js";
import { AttachmentError, ConversationNotFoundError, ExaoneApiError } from "../domain/errors.js";
import type { CompletionProgress, CompletionResult, GenerationSettings, ReasoningEffort } from "../domain/model.js";
import type { ChatCompletionPort, ConversationRepository, TextFileReader } from "../domain/ports.js";
import type { UsageLedger, UsageSummary } from "../domain/usageLedger.js";

export interface AskInput {
  prompt: string;
  system?: string;
  files?: string[];
  conversationId?: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
}

export interface AskOutput {
  conversationId: string;
  turn: number;
  attachedFiles: string[];
  result: CompletionResult;
}

export interface StatusOutput {
  settings: GenerationSettings;
  conversations: number;
  ledger: UsageSummary;
  ping?: { ok: true; result: CompletionResult } | { ok: false; error: string };
}

export interface ServiceDependencies {
  client: ChatCompletionPort;
  conversations: ConversationRepository;
  files: TextFileReader;
  ledger: UsageLedger;
  settings: GenerationSettings;
  attachmentLimits: AttachmentLimits;
  maxTurnsPerConversation: number;
}

/**
 * 유스케이스: EXAONE에게 질문하기, 상태 확인하기.
 * 표현 계층(MCP 도구)과 인프라(HTTP, 파일) 사이의 흐름을 조율한다.
 */
export class ExaoneService {
  constructor(private readonly deps: ServiceDependencies) {}

  async ask(
    input: AskInput,
    options: { signal?: AbortSignal; onProgress?: (p: CompletionProgress) => void } = {},
  ): Promise<AskOutput> {
    const { conversations, settings, ledger } = this.deps;

    const conversation = input.conversationId
      ? this.requireConversation(input.conversationId)
      : new Conversation(randomUUID(), input.system, this.deps.maxTurnsPerConversation);

    const attachments = await this.loadAttachments(input.files ?? []);
    const userContent = composePrompt(input.prompt, attachments);

    const request = {
      messages: conversation.buildMessages(userContent),
      settings: {
        ...settings,
        reasoningEffort: input.reasoningEffort ?? settings.reasoningEffort,
        maxTokens: input.maxTokens ?? settings.maxTokens,
      },
    };

    let result: CompletionResult;
    try {
      result = await this.deps.client.complete(request, options);
    } catch (error) {
      ledger.recordFailure(error instanceof ExaoneApiError ? error.rateLimit : undefined);
      throw error;
    }
    ledger.recordSuccess(result.usage, result.rateLimit);

    conversation.recordExchange(userContent, {
      role: "assistant",
      content: result.content,
      ...(settings.preserveThinking && result.reasoning ? { reasoning_content: result.reasoning } : {}),
    });
    conversations.save(conversation);

    return {
      conversationId: conversation.id,
      turn: conversation.turnCount,
      attachedFiles: attachments.map((a) => a.path),
      result,
    };
  }

  async status(ping: boolean, signal?: AbortSignal): Promise<StatusOutput> {
    const base = {
      settings: this.deps.settings,
      conversations: this.deps.conversations.count(),
    };
    if (!ping) return { ...base, ledger: this.deps.ledger.snapshot() };

    let pingResult: StatusOutput["ping"];
    try {
      const result = await this.deps.client.complete(
        {
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
          settings: { ...this.deps.settings, reasoningEffort: "low", maxTokens: 512 },
        },
        { signal },
      );
      this.deps.ledger.recordSuccess(result.usage, result.rateLimit);
      pingResult = { ok: true, result };
    } catch (error) {
      this.deps.ledger.recordFailure(error instanceof ExaoneApiError ? error.rateLimit : undefined);
      pingResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ...base, ledger: this.deps.ledger.snapshot(), ping: pingResult };
  }

  private requireConversation(id: string): Conversation {
    const found = this.deps.conversations.find(id);
    if (!found) throw new ConversationNotFoundError(id);
    return found;
  }

  private async loadAttachments(paths: string[]): Promise<Attachment[]> {
    const limits = this.deps.attachmentLimits;
    if (paths.length > limits.maxFiles) {
      throw new AttachmentError(`첨부 파일은 최대 ${limits.maxFiles}개입니다 (요청: ${paths.length}개).`);
    }
    const attachments: Attachment[] = [];
    for (const path of paths) {
      const { resolvedPath, bytes } = await this.deps.files.read(path, limits.maxFileBytes);
      if (looksBinary(bytes)) throw new AttachmentError(`${resolvedPath}: 텍스트 파일이 아닌 것 같습니다.`);
      attachments.push({ path: resolvedPath, content: new TextDecoder("utf-8").decode(bytes), bytes: bytes.length });
    }
    assertWithinLimits(attachments, limits);
    return attachments;
  }
}
