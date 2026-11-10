import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExaoneService } from "../application/exaoneService.js";
import { REASONING_EFFORTS } from "../domain/model.js";
import { formatAnswer, formatError, formatStatus } from "./formatters.js";

export interface ServerInfo {
  name: string;
  version: string;
  maskedKey: string;
  defaultEffort: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  workDir: string;
}

const ASK_DESCRIPTION = `Delegate a task or question to K-EXAONE 2.5 (LG AI Research) and return its answer.

Use it to get an independent second opinion, a Korean-native draft or review, or to offload a self-contained subtask.
EXAONE cannot see your workspace, tools or this conversation: put every needed fact in \`prompt\`, or pass local text files with \`files\` (the server reads them itself, so their contents do not have to pass through your context).
EXAONE is text-only and always reasons before answering. Higher \`reasoning_effort\` is slower and uses more tokens.
To ask a follow-up in the same thread, pass the \`conversation_id\` printed at the end of the previous answer.
The answer ends with a [k-exaone-mcp] footer showing token usage and remaining API rate limits.`;

const STATUS_DESCRIPTION = `Show k-exaone-mcp settings, token usage accumulated by this server process, and the latest EXAONE API rate-limit headers. With ping=true (default) it also sends one tiny request to verify the API key and connectivity.`;

/** 표현 계층: MCP 도구 정의와 입력 검증, 응답 변환만 담당한다. */
export function createServer(service: ExaoneService, info: ServerInfo): McpServer {
  const server = new McpServer({ name: info.name, version: info.version });

  server.registerTool(
    "ask_exaone",
    {
      title: "Ask K-EXAONE",
      description: ASK_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1).describe("Instruction or question for EXAONE. Be explicit; it has no other context."),
        system: z
          .string()
          .optional()
          .describe("Optional system prompt (role, output format). Only used when starting a new conversation."),
        files: z
          .array(z.string())
          .optional()
          .describe("Absolute paths of local UTF-8 text files to attach (code, docs, logs). Binary files are rejected."),
        conversation_id: z
          .string()
          .optional()
          .describe("Continue a previous conversation. Omit to start a new one."),
        reasoning_effort: z
          .enum(REASONING_EFFORTS)
          .optional()
          .describe(`low (fast) / medium / high / max (deepest, slowest). Default: ${info.defaultEffort}.`),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Upper bound for generated tokens INCLUDING reasoning. Leave unset unless you need a cap."),
        include_reasoning: z
          .boolean()
          .optional()
          .describe("Also return EXAONE's reasoning trace (long). Default false."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      const progressToken = extra._meta?.progressToken;
      let lastProgress = 0;
      const onProgress =
        progressToken === undefined
          ? undefined
          : (p: { phase: string; reasoningChars: number; contentChars: number }) => {
              const progress = Math.max(lastProgress + 1, p.reasoningChars + p.contentChars);
              lastProgress = progress;
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress,
                    message: p.phase === "reasoning" ? `EXAONE 추론 중… (${p.reasoningChars}자)` : `EXAONE 답변 작성 중… (${p.contentChars}자)`,
                  },
                })
                .catch(() => undefined);
            };

      try {
        const output = await service.ask(
          {
            prompt: args.prompt,
            ...(args.system !== undefined && { system: args.system }),
            ...(args.files !== undefined && { files: args.files }),
            ...(args.conversation_id !== undefined && { conversationId: args.conversation_id }),
            ...(args.reasoning_effort !== undefined && { reasoningEffort: args.reasoning_effort }),
            ...(args.max_tokens !== undefined && { maxTokens: args.max_tokens }),
          },
          { signal: extra.signal, ...(onProgress && { onProgress }) },
        );
        const effort = args.reasoning_effort ?? info.defaultEffort;
        return { content: [{ type: "text", text: formatAnswer(output, effort, args.include_reasoning ?? false) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: formatError(error) }] };
      }
    },
  );

  server.registerTool(
    "exaone_status",
    {
      title: "K-EXAONE status & usage",
      description: STATUS_DESCRIPTION,
      inputSchema: {
        ping: z.boolean().optional().describe("Send a tiny test request (uses a few hundred tokens). Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const status = await service.status(args.ping ?? true, extra.signal);
        return {
          content: [
            {
              type: "text",
              text: formatStatus(status, info.maskedKey, {
                maxFileBytes: info.maxFileBytes,
                maxTotalBytes: info.maxTotalBytes,
                workDir: info.workDir,
              }),
            },
          ],
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: formatError(error) }] };
      }
    },
  );

  return server;
}
