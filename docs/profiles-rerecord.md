# Sprint 1 契约：登录态持久化 + 单步重录

> 目标用户：业务人员。两个能力决定产品"能不能用"：
>
> 1. **登录态**：录制时登录一次，回放自动带上（企业系统 SSO/登录是最大启动障碍）；
> 2. **单步重录**：某一步因页面改版失效时，只重录这一步，不用整条重来。

---

## A. 登录态（storageState profiles）

### A.1 存储

- 目录：`<repo>/profiles/`（Studio server 可注入 `profilesDir`，默认仓库根下）。
- 文件名：`<originKey>.json`，`originKey = slug(host_port) + '-' + sha1(origin).slice(0,8)`，例如
  `www.example-com-1a2b3c4d.json`、`127.0.0.1_5173-9f8e7d6c.json`（slug 只留 `[a-z0-9._-]`）。
- 内容：
  ```jsonc
  { "origin": "https://www.example.com", "savedAt": "ISO", "storageState": { "cookies": [...], "origins": [...] } }
  ```
  `storageState` 直接用 Playwright 的 `context.storageState()`（cookie + localStorage）。
- `.gitignore` 加 `profiles/`（含登录凭证，绝不入库）。

### A.2 录制/回放自动带登录态

- **录制**：`record()` 前按起始 URL 的 origin 找 profile → `browser.newContext({ storageState })`；停止时 `context.storageState()` 写回 profile（自动刷新）。
- **回放**：`playRuns()` 按 flow.meta.env.startUrl 的 origin 找 profile → context 带 storageState。
- 没有 profile 时行为不变（等同今天）。
- 实现落点：
  - `@rr/recorder`：`RecordOptions.storageStatePath?`（读）、`saveStorageStatePath?`（写，停止时保存）
  - `@rr/executor`：`PlayOptions.storageStatePath?`（读）；`saveStorageStatePath?`（写，run 结束后尽力保存，失败不影响结果）
  - 路径查找逻辑放 Studio（`profilesDir` + originKey），core 包只接收路径。

### A.3 登录/更新登录态（显式流程，不录制）

业务人员场景："登录过期了，我重新登一下。"

| 方法   | 路径                                    | body            | 返回                              |
| ------ | --------------------------------------- | --------------- | --------------------------------- |
| POST   | `/api/profiles/login/start`             | `{ url }`       | `{ sessionId }`                   |
| GET    | `/api/profiles/login/status?sessionId=` | —               | `{ running: boolean; elapsedMs }` |
| POST   | `/api/profiles/login/stop`              | `{ sessionId }` | `{ profile: ProfileMeta }`        |
| POST   | `/api/profiles/login/cancel`            | `{ sessionId }` | `{ ok: true }`                    |
| GET    | `/api/profiles`                         | —               | `{ profiles: ProfileMeta[] }`     |
| DELETE | `/api/profiles/:originKey`              | —               | `{ ok: true }`                    |

`ProfileMeta = { originKey, origin, savedAt, cookieCount, localStorageOrigins }`。
登录会话行为：打开可见浏览器（带现有 profile）→ 用户自己登录 → 用户在 Studio 点「完成，保存登录态」→ 保存 storageState → 关闭浏览器。超时 10 分钟自动关闭不保存。

### A.4 失败提示

登录过期无法可靠检测，MVP 用启发式：回放失败且当前 URL 命中
`/login|signin|sign-in|auth|sso|登录/` 时，错误信息追加一句人话：
「登录状态可能已过期，请在 Studio 里点『更新登录态』重新登录一次」。
（前端按 `reason` 里是否含该提示展示按钮。）

### A.5 安全

- profile 含 cookie/凭证：只落本地 `profiles/`，`gitignore`；Studio API 不返回 cookie 原文（只返回计数）；
- 删除接口只允许删除 profilesDir 下的文件（路径安全校验）。

---

## B. 单步重录（方案 A：手动定位 + 录制候选动作 + 选择替换）

### B.1 交互

1. 用户在步骤时间线点「重录这一步」；
2. 弹确认：「会打开一个浏览器窗口，你手动走到这一步所在的页面，操作一遍；录制只在你本机进行，不会上传」；
3. 浏览器打开到 `flow.meta.env.startUrl`（自动带该站登录态），开始**普通录制**（记录用户所有操作）；
4. 用户到达目标页面并做出目标动作后，点 Studio 的「停止并选择这一步」；
5. Studio 弹出候选列表：本次录到的所有动作（标题、kind、值摘要、截图可选），用户**选一个** → 「用它替换第 N 步」；
6. 后端用候选动作替换原步骤（**保留原 stepId**，保证历史/引用稳定），version+1、`.bak`；返回最新 flow/steps/suggestions；
7. 可选：替换后提示「建议跑一次自检」。

### B.2 API

| 方法 | 路径                                             | body                       | 返回                                                            |
| ---- | ------------------------------------------------ | -------------------------- | --------------------------------------------------------------- |
| POST | `/api/flows/:file/steps/:stepId/rerecord/start`  | —                          | `{ sessionId, target: { stepId, stepIndex, title }, startUrl }` |
| POST | `/api/flows/:file/steps/:stepId/rerecord/stop`   | `{ sessionId }`            | `{ candidates: StepSummary[], tempFile }`                       |
| POST | `/api/flows/:file/steps/:stepId/replace`         | `{ tempFile, tempStepId }` | `{ ok, flow, steps, suggestions }`                              |
| POST | `/api/flows/:file/steps/:stepId/rerecord/cancel` | `{ sessionId }`            | `{ ok: true }`（关闭浏览器、删临时文件）                        |

- 临时录制文件放 `flows/.rerecord/<sessionId>.json`（`gitignore`：`flows/.rerecord/`），replace 成功后删除；会话取消也删除。
- 会话与录制会话复用同一套 session 管理（`purpose: 'rerecord'`），但**停止后不跑自检**。
- 替换校验：`tempStep` 必须存在；原 flow 必须是合法 IR；替换后必须 `parseFlow` 通过。

### B.3 前端

- 时间线每步有「重录」按钮（录制中/回放中禁用）；失败步骤额外提示「可以重录这一步」。
- 重录会话期间顶部显示 banner：`正在录制备选动作…请在新窗口里操作到目标位置，然后点『停止并选择这一步』` + 「停止并选择」/「取消」按钮。
- 候选列表弹窗：单选（radio）+ 步骤标题/kind/值摘要 + 「用它替换」；空列表时提示「这次没有录到操作，请重试」。

### B.4 已知限制

- 候选动作包含用户"导航过程中的多余动作"，由用户选择正确的那个（这是方案 A 的取舍，避免自动回放前缀的副作用）；
- 替换只支持普通步骤（不支持 group 容器）；
- 替换后原步骤的 `id` 保留，但 `expect` 采用新录制推断的 expect（更贴合当前页面）。
