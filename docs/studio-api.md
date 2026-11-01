# Studio（本地 Web 控制台）API 契约 v0.1

> 目标用户：业务人员。形态：本地 Node 服务 + 受控 Chromium + 单页 Web UI。
> 启动：`pnpm studio`（默认 http://127.0.0.1:4400）

## 页面结构（前端约定）

```
┌──────────────────────────────────────────────────────────────┐
│  [URL 输入框]  [● 开始录制]   [停止并保存]   流程标题：____   │
├──────────────────┬───────────────────────────────────────────┤
│ 流程列表          │ 步骤时间线（录制中实时追加 / 选中流程展示）│
│ · 登录并提交报销   │ 1. 打开 xxx            [截图缩略图]        │
│ · 每月对账        │ 2. 输入「姓名」= Alice                      │
│ ...              │ 3. 点击「保存」  ✔ L1 45ms                  │
│                  │ ...                                        │
│                  ├───────────────────────────────────────────┤
│                  │ [▶ 回放] [自检]  变量：password=____       │
│                  │ 回放进度 / 每步状态 / 失败原因（人话）     │
└──────────────────┴───────────────────────────────────────────┘
```

- 全部中文、大字号、按钮明显；失败状态用红色 + 一句人话原因 + 「重新录制这一步」提示。
- 不用任何前端框架/构建步骤：`packages/studio/public/{index.html,app.js,styles.css}`。
- 轮询即可（500ms），不要求 WebSocket/SSE。

## REST API

### 流程

- `GET /api/flows` → `{ flows: Array<{ file: string; title: string; steps: number; version: number; updatedAt: string }> }`
- `GET /api/flows/:file` → `{ flow: Flow; steps: Array<StepSummary> }`
- `POST /api/flows/:file/rename` body `{ title: string }` → `{ ok: true }`
- `POST /api/flows/:file/steps/:stepId/delete` → `{ ok: true; flow: Flow }`
- `POST /api/flows/:file/variables` body `{ variables: Array<{name,value}> }` → `{ ok: true }`

`StepSummary = { index: number; id: string; kind: string; title: string; description?: string; expect?: string; screenshot?: string /* URL */ }`

`title` 由后端生成人话：`打开 <url>` / `输入 <值> 到 <描述>` / `点击 <描述>` / `选择 <值>` / `按键 <key>` / `等待 <条件>` / `断言 <...>`。

### 录制

- `POST /api/record/start` body `{ url: string; title?: string }` → `{ sessionId: string }`
  - 后端启动**可见**的受控 Chromium（headless:false），开始采集。
- `GET /api/record/status?sessionId=...` → `{ recording: boolean; steps: StepSummary[]; elapsedMs: number }`
- `POST /api/record/stop` body `{ sessionId: string }` → `{ file: string; flow: Flow; selfCheck: SelfCheck }`
  - 保存到 `flows/studio-<yyyymmdd-hhmmss>.json` 并自动跑一次自检（1 次回放，headless）
- `POST /api/record/cancel` body `{ sessionId }` → 关闭浏览器、丢弃录制

`SelfCheck = { ok: boolean; steps: Array<{ id: string; status: 'pass'|'fail'; level?: string; reason?: string }>; summary: string }`

### 回放

- `POST /api/play` body `{ file: string; runs?: number; variables?: Record<string,string>; headed?: boolean }` → `{ runId: string }`
- `GET /api/runs/:runId` → `{ status: 'running'|'done'|'error'; file: string; runs: Array<{ ok: boolean; steps: Array<{ id: string; kind: string; status: string; level?: string; ms: number; reason?: string; code?: string; screenshot?: string }> }>; message?: string }`
- `POST /api/runs/:runId/stop` → 尽量中止（可选实现）

### 静态资源

- `GET /artifacts/*` → artifacts 目录下的文件（截图等），直接以 `Content-Type` 返回。
- `GET /api/config` → `{ aiEnabled: boolean; flowsDir: string; artifactsDir: string }`

## 错误码 → 人话（后端统一映射，前端直接展示 `reason`）

| code              | 人话                                             |
| ----------------- | ------------------------------------------------ |
| ELEMENT_NOT_FOUND | 页面上找不到这个元素，可能页面改版了或还没加载完 |
| NOT_ACTIONABLE    | 找到了元素但暂时点不了（被遮挡/不可见/未启用）   |
| NO_EFFECT         | 点了但页面没有反应，可能需要再确认一次           |
| EXPECT_MISMATCH   | 操作后页面没有出现预期变化                       |
| NAVIGATION_FAILED | 页面打开失败，检查网址或网络                     |
| BROWSER_CRASH     | 浏览器异常退出                                   |
| VARIABLE_MISSING  | 缺少运行参数（变量未填写）                       |

### CSV 批量执行（v0.5 新增，契约详见 docs/batch-run.md §C）

- `POST /api/flows/:file/batch/start` body `{ csvText, mapping?, options? }` → `{ batchId, total, columns, mapping, missingVariables, warnings }`
- `GET /api/batches/:id` → `{ status, total, completed, okCount, failCount, rows, startedAt, finishedAt?, message? }`
- `POST /api/batches/:id/stop` → `{ ok, stopped }`（当前行跑完再停）
- `GET /api/batches/:id/export.csv` → 结果 CSV（UTF-8 BOM；原列 + 状态/失败步骤/失败原因/耗时ms）

错误：`CsvError` / `BatchError` → 400 `{ error, code }`；批次不存在 → 404；其余 → 500。
批次只存进程内存（Studio 重启即丢）。

### 登录态 profiles（v0.4 新增，契约详见 docs/profiles-rerecord.md §A.3）

- `GET /api/profiles` → `{ profiles: ProfileMeta[] }`（只返回计数，不返回 cookie 原文）
- `POST /api/profiles/login/start` body `{ url }` → `{ sessionId }`（打开可见浏览器，用户自己登录）
- `GET /api/profiles/login/status?sessionId=` → `{ running, elapsedMs? }`
- `POST /api/profiles/login/stop` body `{ sessionId }` → `{ ok, profile }`（保存 storageState）
- `POST /api/profiles/login/cancel` body `{ sessionId }` → `{ ok: true }`
- `DELETE /api/profiles/:originKey` → `{ ok: true }` / 404

录制与回放会自动按 `flow.meta.env.startUrl` 的 origin 读写该 profile；录制停止时自动刷新保存。

### 单步重录（v0.4 新增，契约详见 docs/profiles-rerecord.md §B.2）

- `POST /api/flows/:file/steps/:stepId/rerecord/start` → `{ sessionId, startUrl, target }`
- `POST /api/flows/:file/steps/:stepId/rerecord/stop` body `{ sessionId }` → `{ candidates, tempFile }`
- `POST /api/flows/:file/steps/:stepId/rerecord/cancel` body `{ sessionId }` → `{ ok: true }`
- `POST /api/flows/:file/steps/:stepId/replace` body `{ tempFile, tempStepId }` → `{ ok, flow, steps, suggestions }`

替换保留原 stepId、`version+1`、写 `.bak`；临时录制文件在 `flows/.rerecord/`（gitignore），替换成功或取消后删除。

### 参数化建议（v0.3 新增，契约详见 docs/parameterization.md）

- `GET /api/flows/:file/suggestions?includeWeak=0` → `FlowSuggestions`
- `POST /api/flows/:file/apply-suggestion` body `{ stepId, name, type?, applySameValue? }` → `{ ok, flow, steps, suggestions }`
- `POST /api/flows/:file/apply-suggestions` body `{ apply: ApplySuggestionInput[] }` → 同上（先整体校验）
- `POST /api/flows/:file/variables/rename` body `{ from, to }` → `{ ok, flow }`

错误：`SuggestError` → 400 `{ error, code }`；参数错 → 400 `{ error, code:'BAD_REQUEST' }`；flow 不存在 → 404。
apply 后不自动自检；`suggestions` 重算失败时为 `null`（写入已成功）。

## 非目标（v0.1 不做）

- 多标签页/多系统流程（下一版）
- 变量 CSV 批量
- 权限/分享
- AI 兜底开关（只展示与 AI 相关的失败提示，不真正调用）
