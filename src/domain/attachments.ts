import { AttachmentError } from "./errors.js";

export interface AttachmentLimits {
  /** 파일 하나의 최대 바이트 수 */
  maxFileBytes: number;
  /** 첨부 전체의 최대 바이트 수 */
  maxTotalBytes: number;
  /** 한 번에 첨부할 수 있는 최대 파일 수 */
  maxFiles: number;
}

export interface Attachment {
  path: string;
  content: string;
  bytes: number;
}

export function assertWithinLimits(attachments: Attachment[], limits: AttachmentLimits): void {
  if (attachments.length > limits.maxFiles) {
    throw new AttachmentError(`첨부 파일은 최대 ${limits.maxFiles}개입니다 (요청: ${attachments.length}개).`);
  }
  let total = 0;
  for (const a of attachments) {
    if (a.bytes > limits.maxFileBytes) {
      throw new AttachmentError(
        `${a.path}: ${formatBytes(a.bytes)}로 파일당 한도 ${formatBytes(limits.maxFileBytes)}를 넘습니다.`,
      );
    }
    total += a.bytes;
  }
  if (total > limits.maxTotalBytes) {
    throw new AttachmentError(`첨부 합계 ${formatBytes(total)}가 한도 ${formatBytes(limits.maxTotalBytes)}를 넘습니다.`);
  }
}

/** 텍스트 파일로 보이지 않으면(NUL 바이트 포함) 거부한다. */
export function looksBinary(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

/** 질의 본문 뒤에 첨부 파일을 XML 비슷한 태그로 붙인다. */
export function composePrompt(prompt: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return prompt;
  const blocks = attachments.map((a) => `<file path="${a.path}">\n${a.content}\n</file>`);
  return `${prompt}\n\n<attached_files>\n${blocks.join("\n")}\n</attached_files>`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
