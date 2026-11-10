# k-exaone-mcp

[![CI](https://github.com/pally4u/k-exaone-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/pally4u/k-exaone-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/k-exaone-mcp)](https://www.npmjs.com/package/k-exaone-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Claude, Gemini(Antigravity), Cline 같은 **MCP 클라이언트가 LG AI연구원의 K-EXAONE 2.5에게 일을 맡기고 답을 받아 오게 하는 MCP 서버**입니다.
Hermes나 OpenCode 같은 별도 에이전트 CLI를 설치하지 않아도 되고, **각자 자기 EXAONE API 키만 넣으면** 바로 쓸 수 있습니다.

```text
나 ─▶ Claude / Gemini ─(ask_exaone)─▶ k-exaone-mcp ─▶ EXAONE API (K-EXAONE 2.5)
                  ◀──────── 답변 + 토큰 사용량 + 남은 호출 한도 ◀──────────
```

> LG AI연구원의 공식 프로젝트가 아닌 개인 오픈소스입니다. EXAONE은 LG AI연구원의 상표입니다.

## 할 수 있는 일

- **작업 위임과 교차 검토**: "이 설계안을 엑사원한테 검토받아 줘", "엑사원 답이랑 비교해 줘"
- **로컬 파일 첨부**: `files`에 경로를 넘기면 서버가 직접 파일을 읽어 EXAONE에게 보냅니다. 파일 내용이 Claude의 컨텍스트를 거치지 않으므로 Claude 토큰을 아낄 수 있습니다.
- **이어서 대화**: 답변 끝의 `conversation_id`를 넘기면 이전 대화와 추론을 이어 갑니다(`preserve_thinking`).
- **추론 강도 선택**: `low` / `medium` / `high` / `max`
- **사용량 표시**: 모든 답변 끝에 토큰 사용량과 남은 호출 한도(초·분·일)를 붙입니다. `exaone_status` 도구로 누적 사용량을 볼 수 있습니다.
- **호출 한도 자동 처리**: 초당 한도(429)에 걸리면 잠깐 기다렸다가 다시 보냅니다. 일일 한도를 다 썼으면 그 사실을 바로 알려 줍니다.

## 빠른 시작

### 1. API 키 발급

[EXAONE API Platform](https://docs.exaone.ai/ko/docs/authentication)에서 키를 발급받습니다.

### 2. MCP 클라이언트에 등록

필요한 설정은 **`EXAONE_API_KEY` 하나뿐**입니다. 공식 가이드에 나온 `temperature=1.0`, `top_p=0.95`, `preserve_thinking=true` 같은 권장값은 서버에 기본값으로 들어 있습니다.

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add exaone --scope user -e EXAONE_API_KEY=발급받은키 -- npx -y k-exaone-mcp
```

Windows(네이티브)에서는 `npx` 앞에 `cmd /c`를 붙입니다.

```bash
claude mcp add exaone --scope user -e EXAONE_API_KEY=발급받은키 -- cmd /c npx -y k-exaone-mcp
```
</details>

<details>
<summary><b>Claude Desktop</b></summary>

`설정 → 개발자 → 구성 편집`에서 `claude_desktop_config.json`을 엽니다.

```json
{
  "mcpServers": {
    "exaone": {
      "command": "npx",
      "args": ["-y", "k-exaone-mcp"],
      "env": { "EXAONE_API_KEY": "발급받은키" }
    }
  }
}
```
</details>

<details>
<summary><b>Google Antigravity (Gemini)</b></summary>

에이전트 패널의 `…` 메뉴에서 `MCP Servers → Manage MCP Servers → View raw config`를 열고 `mcpServers`에 Claude Desktop과 같은 블록을 추가합니다.
</details>

<details>
<summary><b>VS Code (Copilot) · Cline · Cursor 등</b></summary>

`mcpServers` 형식을 쓰는 클라이언트에는 Claude Desktop과 같은 JSON을 넣습니다. VS Code의 `.vscode/mcp.json`은 키 이름이 `servers`입니다.

```json
{
  "servers": {
    "exaone": {
      "command": "npx",
      "args": ["-y", "k-exaone-mcp"],
      "env": { "EXAONE_API_KEY": "발급받은키" }
    }
  }
}
```
</details>

### 3. 써 보기

클라이언트를 다시 시작한 뒤 이렇게 요청해 보세요.

- "exaone_status로 연결 확인해 줘"
- "`src/auth.ts`를 엑사원한테 보내서 보안 문제를 검토받아 줘"
- "이 README 초안을 엑사원한테 자연스러운 한국어로 다듬어 달라고 해"

## 도구

### `ask_exaone`

| 인자 | 타입 | 설명 |
|---|---|---|
| `prompt` | string, 필수 | EXAONE에게 보낼 지시나 질문. EXAONE은 대화 맥락을 모르므로 필요한 내용을 모두 담아야 합니다. |
| `system` | string | 시스템 프롬프트. 새 대화를 시작할 때만 적용됩니다. |
| `files` | string[] | 첨부할 UTF-8 텍스트 파일 경로(절대 경로 권장). 바이너리는 거부합니다. |
| `conversation_id` | string | 이전 대화를 이어 갈 때 씁니다. |
| `reasoning_effort` | `low`·`medium`·`high`·`max` | 추론 강도. 기본값은 `high`입니다. |
| `max_tokens` | int | 생성 토큰 상한(추론 포함). 보통은 비워 둡니다. |
| `include_reasoning` | boolean | EXAONE의 추론 과정도 함께 돌려받습니다. 기본값은 false입니다. |

응답 예시:

```text
이 프로젝트는 MCP 클라이언트가 K-EXAONE 2.5에게 작업을 위임하게 해 주는 MCP 서버입니다.

---
[k-exaone-mcp]
conversation_id: eaa07c68-702d-4731-b274-c657950c09cd (turn 1)
model: k-exaone_v2.5 · effort: low · 2.5s
tokens: in 555 / out 61 (reasoning 13)
rate limit remaining: second 0/1, minute 59/60, day 89/100
attached: C:\work\project\package.json
```

### `exaone_status`

설정(키는 끝 4자리만 표시), 이 서버 프로세스의 누적 토큰 사용량, 마지막으로 받은 호출 한도 헤더를 보여 줍니다. `ping: true`(기본값)이면 작은 요청을 한 번 보내 키와 연결 상태를 확인합니다.

## 사용량과 호출 한도

EXAONE API는 [응답 헤더](https://docs.exaone.ai/ko/docs/rate-limits)로 남은 호출 횟수를 알려 줍니다. 토큰 사용량은 응답 본문의 `usage`에 들어 있습니다. 둘 다 이 서버가 읽어서 보여 줍니다.

| 헤더 | 의미 |
|---|---|
| `x-{second,minute,day}-rate-limit` | 구간별 최대 호출 횟수 |
| `x-{second,minute,day}-rate-limit-remaining` | 구간별 남은 호출 횟수 |
| `retry-after`, `retry-after-ms` | 다시 요청할 수 있을 때까지 기다릴 시간 |

2026-11-10에 무료 키로 실제 호출했을 때 관측한 한도는 **초당 1회, 분당 60회, 하루 100회**였습니다. 한도는 계정이나 정책에 따라 달라질 수 있습니다.
하루 100회는 에이전트가 쓰기에는 빠듯하므로, 꼭 필요한 작업만 맡기는 위임·검토 용도에 맞습니다.

계정 전체의 누적 사용량을 조회하는 API는 없습니다(`GET /v1/usage`는 404). 계정 전체 사용량은 EXAONE API Platform 콘솔에서 확인하세요.

## 설정 (환경변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `EXAONE_API_KEY` | (필수) | API 키 |
| `EXAONE_REASONING_EFFORT` | `high` | 기본 추론 강도 `low`·`medium`·`high`·`max` |
| `EXAONE_MAX_TOKENS` | (없음) | 기본 생성 토큰 상한 |
| `EXAONE_TIMEOUT_MS` | `600000` | 요청 시간 제한(ms). `max` 추론은 오래 걸릴 수 있습니다. |
| `EXAONE_WORKDIR` | 서버 실행 폴더 | `files`의 상대 경로를 해석할 기준 폴더 |
| `EXAONE_MAX_FILE_KB` / `EXAONE_MAX_TOTAL_KB` | `512` / `1536` | 첨부 한도(파일당 / 합계) |
| `EXAONE_TEMPERATURE` / `EXAONE_TOP_P` | `1.0` / `0.95` | 샘플링 설정(공식 권장값) |
| `EXAONE_PRESERVE_THINKING` | `true` | 이어지는 대화에서 이전 추론을 유지할지 여부 |
| `EXAONE_BASE_URL` / `EXAONE_MODEL` | `https://api.exaone.ai/v1` / `k-exaone_v2.5` | OpenAI 호환으로 띄운 다른 EXAONE 엔드포인트에 연결할 때 바꿉니다. |

## 알아 둘 점

- **EXAONE은 직접 파일을 수정하거나 명령을 실행하지 않습니다.** 결과를 받아 실제로 반영하는 것은 호출한 AI(Claude 등)입니다.
- K-EXAONE 2.5는 텍스트 전용 모델입니다. 이미지와 PDF는 첨부할 수 없습니다.
- 대화 기록은 서버 메모리에만 있습니다. 클라이언트를 다시 시작하면 사라집니다(최근 50개 대화, 대화당 20턴까지 보관).
- 첨부한 파일 내용과 질문은 EXAONE API로 전송됩니다. 회사 코드를 보내기 전에 [이용약관](https://docs.exaone.ai/ko/terms/terms-of-service)을 확인하세요.
- API 키는 로그나 도구 출력에 끝 4자리만 나옵니다.

## 개발

```bash
npm install
npm run typecheck && npm test   # 단위·통합 테스트 (API 호출 없음)
npm run build                   # dist/ 생성
```

실제 API로 확인하려면 `.env.example`을 `.env`로 복사하고 키를 넣은 뒤 실행합니다. 두 명령 모두 일일 호출 한도를 소모합니다.

```bash
npm run verify:api   # 헤더·usage·reasoning_effort·tool calling 등 11개 항목 확인 (약 11회 호출)
npm run smoke        # 빌드된 서버를 stdio MCP로 띄워 실제 사용 흐름 확인 (2회 호출)
npm run inspect      # MCP Inspector로 도구를 직접 호출해 보기
```

npm 배포 전에 로컬 빌드로 연결하려면 `npx -y k-exaone-mcp` 대신 `node /절대경로/k-exaone-mcp/dist/index.js`를 씁니다.

### 구조

레이어드 아키텍처로 나눴고, 의존 방향은 위에서 아래로만 흐릅니다.

```text
src/
├─ index.ts                 진입점: 설정을 읽고 각 계층을 조립해 stdio 서버 실행
├─ config.ts                환경변수 → AppConfig
├─ presentation/            MCP 도구 정의, 입력 검증(zod), 응답 문구
├─ application/             유스케이스(ask, status) 흐름 조율
├─ domain/                  모델, 대화, 첨부 규칙, 사용량 집계, 포트(인터페이스)
└─ infrastructure/          EXAONE HTTP·SSE 클라이언트, 파일 읽기, 메모리 저장소
```

## 라이선스

[MIT](LICENSE)
