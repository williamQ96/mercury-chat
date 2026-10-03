# mercury chat

A small, local chat app for an already tunneled Mercury LLM. English is the default; choose **中文** in the Language selector for the complete Chinese interface. Only the language preference is saved. Switching language keeps the current conversation and does not send another request.

Built with Node.js and plain HTML, CSS, and JavaScript. No npm dependencies, external assets, paid APIs, tools, or uploads. Requires Node.js 22 or newer.

## Start

Keep your existing SSH tunnel open. This app does not start, stop, or modify SSH or Mercury. It expects the OpenAI-compatible API at `http://127.0.0.1:18000/v1`, with model `qwen3-235b`.

From the project directory in PowerShell:

```powershell
.\Start-Chat.ps1
```

Open <http://127.0.0.1:7860>. Manually enter your API key in the password field and click **Use key**. Click **Check connection**, or send a message directly. Never put the key in source code, command arguments, or a committed file.

For a hidden background process:

```powershell
.\Start-Chat.ps1 -Background
.\Stop-Chat.ps1
```

Use Ctrl+C to stop a foreground process. If the port is occupied, use `-Port 7861` and open `http://127.0.0.1:7861`. The stop script affects only the recorded process whose command line matches this project's server file. Restarting the server clears all in-memory keys; enter yours again afterward.

On another platform, run `npm start` or `node server.mjs`. The optional `PORT` environment variable changes the local UI port, never its loopback-only binding or upstream destination.

## Chat

- Enter sends; Shift+Enter inserts a new line. Enter during IME composition does not submit.
- **Stop** cancels the current request and restores your question for editing. Completed turns stay in the conversation. Immediate cessation of upstream computation depends on Mercury's disconnect handling.
- **New chat** cancels a pending request and clears the page context while keeping the in-memory key.
- **Forget key** clears the current session's key. Refreshing the page clears the conversation.
- Replies are non-streaming, with a two-minute timeout and a 2,048-token output limit. A notice appears if a reply reaches that limit.
- Language selection changes interface text, errors, and accessibility labels. It does not translate user messages or model replies.

## Privacy and connection behavior

The UI and backend bind only to `127.0.0.1`. The upstream API address is fixed in the backend; there is no arbitrary URL proxy. Requests use same-origin routing, no permissive CORS, Host/Origin/Fetch Metadata checks, and a session CSRF token for state changes.

The API key stays in backend session memory. The browser briefly holds the user's manual input during submission and clears the password field immediately. No key or conversation goes into localStorage, sessionStorage, IndexedDB, files, logs, URLs, or Git. Only `mercury-chat-language` (`en` or `zh`) is saved in localStorage.

Idle sessions expire after one hour. Stopping the server clears all keys. The HTTP session cookie is HttpOnly and SameSite=Strict. A closed browser normally discards its session cookie; the corresponding server session expires after inactivity. Chat history exists only in the current page's memory.

The interface reports API availability only after `/models` succeeds and lists the target model. It reports a successful chat only after a completed chat request. Missing keys, rejected keys, tunnel failures, and timeouts have separate states. Upstream error bodies are never returned to the page, and exact copies of the key in model replies are masked.

Markdown uses text nodes and fixed DOM elements for headings, lists, emphasis, and code. Model HTML is displayed as text. A restrictive Content Security Policy prevents scripts and resources from outside the app.

## Tests

```powershell
npm test
```

Backend tests use mock transports and explicit dummy values, never real credentials. They cover multi-turn context, duplicate sends, cancellation and resubmission, new chats, 401 errors, tunnel failures, timeouts, secret masking, cross-site protection, the fixed upstream, invalid replies, and both error languages.

Optional browser checks use an isolated temporary Chromium profile and a mock backend:

```powershell
$env:CHAT_TEST_CHROME = 'C:\path\to\chrome.exe'
node test/ui.mjs
$env:CHAT_TEST_LANGUAGE = 'zh'
node test/ui.mjs
```

On the original Windows machine, the test automatically locates the installed Playwright Chromium build. Screenshots and JSON results go into the ignored `test-artifacts/` directory. The checks cover chat interactions, safe Markdown, keyboard behavior, responsive layout, English defaults, complete translations, language switching during a conversation, and language preference persistence. A local server on port 7860 is required for the final unauthenticated screenshot.

Authenticated live Mercury chat, streaming, and long context require separate verification with the user's manually entered key. Mock tests do not establish live model availability.

## 中文说明

默认英文，可在 **Language → 中文** 切换完整中文界面。语言偏好可以记住，聊天内容与 API 密钥不会持久化。切换语言保留当前对话，不会发送新请求。

保持 SSH 隧道窗口打开，启动后访问 <http://127.0.0.1:7860>，在密码框手动输入密钥并点击“使用密钥”。Enter 发送，Shift+Enter 换行；支持停止、重新发送和新建对话。重启服务后，需要重新输入密钥。基础版采用非流式回复；真实认证聊天需由用户输入密钥后另行验证。
