import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { formatBytes } from "../domain/attachments.js";
import { AttachmentError } from "../domain/errors.js";
import type { TextFileReader } from "../domain/ports.js";

/** 로컬 디스크에서 첨부 파일을 읽는다. 상대 경로는 baseDir 기준으로 해석한다. */
export class LocalFileReader implements TextFileReader {
  constructor(private readonly baseDir: string) {}

  async read(path: string, maxBytes: number): Promise<{ resolvedPath: string; bytes: Uint8Array }> {
    const resolvedPath = isAbsolute(path) ? path : resolve(this.baseDir, path);
    let info;
    try {
      info = await stat(resolvedPath);
    } catch {
      throw new AttachmentError(
        `${resolvedPath}: 파일을 찾을 수 없습니다.${isAbsolute(path) ? "" : " 상대 경로 대신 절대 경로를 넘겨 보세요."}`,
      );
    }
    if (!info.isFile()) throw new AttachmentError(`${resolvedPath}: 파일이 아닙니다.`);
    if (info.size > maxBytes) {
      throw new AttachmentError(`${resolvedPath}: ${formatBytes(info.size)}로 파일당 한도 ${formatBytes(maxBytes)}를 넘습니다.`);
    }
    return { resolvedPath, bytes: await readFile(resolvedPath) };
  }
}
