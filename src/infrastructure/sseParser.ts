/**
 * Server-Sent Events 파서. 네트워크 청크가 줄 중간에서 끊겨도 완성된 이벤트만 내보낸다.
 * EXAONE API는 `data: {json}` 한 줄 단위로 보내고 `data: [DONE]` 으로 끝낸다.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];

  /** 청크를 넣고, 이번에 완성된 이벤트의 data 문자열 목록을 돌려받는다. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.consumeLine(line, events);
    }
    return events;
  }

  /** 스트림 끝에서 남은 내용을 마저 처리한다. */
  flush(): string[] {
    const events: string[] = [];
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer, events);
      this.buffer = "";
    }
    this.consumeLine("", events);
    return events;
  }

  private consumeLine(line: string, events: string[]): void {
    if (line === "") {
      if (this.dataLines.length > 0) {
        events.push(this.dataLines.join("\n"));
        this.dataLines = [];
      }
      return;
    }
    if (line.startsWith(":")) return; // 주석(keep-alive)
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      this.dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    // event:, id:, retry: 필드는 이 API에서 쓰지 않으므로 무시한다.
  }
}
