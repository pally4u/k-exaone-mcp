# npm 배포 절차 (관리자용)

`npx -y k-exaone-mcp` 한 줄로 누구나 쓸 수 있게 npm에 올리는 절차입니다. npm에는 심사나 승인 단계가 없어서, 계정만 있으면 `npm publish`를 실행하는 즉시 공개됩니다.

## 처음 한 번만

### 1. 패키지 이름이 비어 있는지 확인

```bash
npm view k-exaone-mcp
```

`404 Not Found`가 나오면 아직 아무도 쓰지 않는 이름이라 등록할 수 있습니다.

### 2. npm 계정 만들기

1. https://www.npmjs.com/signup 에서 가입합니다. Username은 공개 프로필에 표시됩니다.
2. 가입 이메일로 온 인증 메일을 확인합니다. 이메일 인증을 하지 않으면 배포할 수 없습니다.

### 3. 2단계 인증(2FA) 켜기

배포하려면 2FA가 필요합니다.

1. npmjs.com 오른쪽 위 프로필 → **Account** → **Two-Factor Authentication** → **Enable 2FA**
2. 보안 키(Windows Hello, 패스키)나 OTP 앱(Google Authenticator 등)을 등록합니다.
3. 화면에 나오는 **복구 코드를 따로 보관**합니다. 기기를 잃어버렸을 때 이 코드가 없으면 계정을 되찾기 어렵습니다.

### 4. 이 PC에서 로그인

```bash
npm login
```

브라우저가 열리면 로그인하고 2FA를 통과합니다. 로그인됐는지 확인합니다.

```bash
npm whoami
```

## 배포할 때마다

### 5. 배포 전 점검

```bash
git status
```

커밋하지 않은 변경이 없어야 합니다.

```bash
npm pack --dry-run
```

올라갈 파일 목록을 확인합니다. `dist/`, `README.md`, `LICENSE`, `package.json`만 있어야 합니다. `.env`, `src/`, `test/`는 목록에 없어야 정상입니다(`package.json`의 `files` 항목이 이를 제한합니다).

### 6. 패키지 파일로 미리 실행해 보기 (선택)

```bash
npm pack
```

```bash
npx -y ./k-exaone-mcp-0.1.0.tgz --version
```

버전 번호가 출력되면 정상입니다. 확인 후 `.tgz` 파일은 지웁니다.

### 7. 배포

```bash
npm publish
```

- `prepublishOnly` 스크립트가 타입 검사, 테스트, 빌드를 자동으로 먼저 실행합니다. 하나라도 실패하면 배포되지 않습니다.
- 2FA 확인을 요구하면 브라우저나 OTP 입력으로 통과합니다.
- 이 패키지는 scope(`@이름/`)가 없는 이름이라 `--access public`을 붙이지 않아도 공개됩니다.

### 8. 배포 확인

```bash
npm view k-exaone-mcp version
```

```bash
npx -y k-exaone-mcp@latest --version
```

https://www.npmjs.com/package/k-exaone-mcp 페이지에 README가 표시되는지도 확인합니다.

### 9. GitHub에 버전 태그 남기기

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

GitHub 저장소의 **Releases → Draft a new release**에서 이 태그를 고르고 `CHANGELOG.md` 내용을 붙여 릴리스를 만듭니다.

## 새 버전을 낼 때

1. `CHANGELOG.md` 맨 위에 새 버전과 변경 내용을 적고 커밋합니다.
2. 버전 번호를 올립니다. 이 명령이 `package.json`을 고치고 커밋과 태그(`v0.1.1` 등)를 함께 만듭니다.
   ```bash
   npm version patch
   ```
   버그 수정은 `patch`(0.1.0→0.1.1), 기능 추가는 `minor`(0.1.0→0.2.0), 호환이 깨지는 변경은 `major`를 씁니다.
3. 배포합니다.
   ```bash
   npm publish
   ```
4. 커밋과 태그를 함께 올립니다.
   ```bash
   git push --follow-tags
   ```

## 알아 둘 점

- **한 번 쓴 버전 번호는 다시 쓸 수 없습니다.** 잘못 올렸으면 버전을 올려 다시 배포합니다.
- `npm unpublish`는 배포 후 72시간 안에만 할 수 있고, 다른 패키지가 의존하고 있으면 막힙니다. 대신 `npm deprecate k-exaone-mcp@0.1.0 "사유"`로 경고를 띄울 수 있습니다.
- 사용자는 `npx -y k-exaone-mcp`로 실행하므로 새 버전을 올리면 다음 실행부터 반영됩니다. 다만 npx 캐시 때문에 바로 반영되지 않을 수 있습니다. 그럴 때는 `npx -y k-exaone-mcp@latest`로 실행합니다.

## 나중에 고려할 것

- **GitHub Actions에서 자동 배포(Trusted Publishing)**: npm 패키지 설정의 *Trusted Publisher*에 이 저장소와 워크플로를 등록합니다. 그러면 토큰 없이 태그를 푸시할 때마다 배포할 수 있습니다. 워크플로에는 `permissions: id-token: write`가 필요합니다.
- **MCP 공식 레지스트리 등록**: `package.json`에 `"mcpName": "io.github.pally4u/k-exaone-mcp"`를 추가하고 `server.json`을 작성합니다. 그다음 `mcp-publisher login github`, `mcp-publisher publish`로 등록하면 MCP 클라이언트의 서버 검색에 노출됩니다.
