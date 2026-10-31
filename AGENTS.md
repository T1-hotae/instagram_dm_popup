# AGENTS.md

이 저장소에서 코드를 고치는 사람(또는 AI 에이전트)이 지킬 규칙이다.

## 먼저 읽을 것
- `docs/[00] 구조.md`: 창 구성, 알림 흐름, IPC 채널
- `docs/[01] 업데이트 내역.md`: 최근 변경과 남은 문제

## 문서 습관 (필수)
- 코드를 바꾸면 **같은 작업 안에서** `docs/[01] 업데이트 내역.md` 맨 위에 날짜별 항목을 추가한다. 항목에는 증상, 원인, 수정, 남은 문제를 적는다.
- 창, IPC 채널, 알림 흐름, 파일 구성이 바뀌면 `docs/[00] 구조.md`도 고친다.
- 새 문서는 `docs/[NN] 제목.md` 형식으로 번호를 이어서 만든다(예: `[02] 알림 API 조사.md`).
- 사용자가 보는 동작(메뉴, 실행 방법, 한계)이 바뀌면 `README.md`도 고친다.

## 실행
```bash
npm install
npm start            # 앱 실행
npm run test-popup   # 팝업 모양만 확인
npm run dist         # dist/에 설치 파일 만들기
```
- VS Code 터미널 등에 `ELECTRON_RUN_AS_NODE=1`이 설정돼 있으면 Electron이 Node로 실행되어 `app`이 `undefined`가 된다(`Cannot read properties of undefined (reading 'userAgentFallback')`). 이 변수를 지우고 실행한다.
- 이미 실행 중이면 단일 인스턴스 잠금 때문에 새로 띄운 앱은 바로 종료되고, 기존 창이 앞으로 나온다. 코드를 바꾼 뒤에는 트레이 → 종료로 끄고 다시 실행한다.

## 코드 규칙
- 주석, 로그, UI 문구는 한국어로 쓴다. 주변 코드의 밀도와 문체에 맞춘다.
- **로그와 진단 파일에 메시지 내용, 이름, 프로필 URL을 남기지 않는다.** 상태, 개수, 경로(pathname)만 남긴다.
- Instagram 페이지는 `igView.webContents`이고, `mainWindow.webContents`는 타이틀바다. 헷갈리지 않는다.
- 모든 창은 `contextIsolation: true`, `sandbox: true`로 둔다. 페이지와는 preload의 `contextBridge`와 IPC로만 주고받는다.
- `preload.js`의 `webFrame.executeJavaScript` 템플릿 문자열 안에서는 백슬래시를 두 번 쓴다(`'\\n'`). 백틱과 `${`는 쓰지 않는다.
- Instagram 내부 경로와 DOM 구조는 언제든 바뀐다. 실패해도 멈추지 않게 `try/catch`로 감싸고 더 단순한 대체 경로를 남긴다. 계정 보호를 위해 요청 빈도를 늘리지 않는다(401/403/429면 10분 멈춤).
- 알림은 **새 DM일 때만** 띄운다. 좋아요 같은 활동 알림이나 이미 읽은 메시지가 팝업이 되는 변경은 하지 않는다.

## 확인
- 테스트 코드는 없다. `node --check src/*.js`로 문법을 확인한 뒤 앱을 실행해서 본다.
- 트레이 → **알림 경로 점검**, **로그 파일 열기**(`%APPDATA%\insta-dm\insta-dm.log`), **감시 창 보기**로 동작을 확인한다.
- 커밋 메시지는 `fix: …`, `feat: …`, `docs: …` 형식으로 쓴다.
