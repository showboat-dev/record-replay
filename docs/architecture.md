# RR 架构与接口契约（M0/M1 基线）

> 产品：网页操作录制回放引擎。本文件是各 package 的**接口约定**，并行开发时以这里为准。
> IR 定义见 `packages/schema/src/schema.ts`（唯一真源，已通过 18 个单测）。

## 0. 仓库约定

- ESM only；Node >= 20；pnpm workspace；`@rr/*` 包之间通过 tsconfig paths 引用（source-first，不构建）。
- 代码风格：**tab 缩进、单引号、无分号**（`.prettierrc`）；`pnpm typecheck` 必须为 0 错误。
- 测试与源码同目录：`*.test.ts`，`pnpm test` 只跑单元测试；`e2e/*.test.ts` 用 `pnpm e2e`（会启动真实 Chromium）。
- **不新增第三方依赖**；需要时先找 Lead 确认。现有依赖：`playwright@1.64.1`、`zod@3`、`picocolors`、`tsx`、`vitest`、`typescript`。
- 不做 `git commit`（Lead 统一提交）。
- 中文注释/文档可以；标识符、日志 key、错误码用英文。

## 1. 包边界

```
@rr/schema    IR 类型 + zod + 迁移 + 契约校验（已完成，勿改）
@rr/recorder  录制：Chromium + addInitScript 采集 + 合流 + 生成 IR
@rr/resolver  解析：ElementRef → Playwright Locator（L1 语义 / L2 指纹）
@rr/executor  执行：按 IR 逐步 resolve→act→verify，产出 RunResult + artifact
@rr/ai        AI 兜底：OpenAI 兼容客户端 + 脱敏 + 修复提示词（默认关闭）
@rr/harness   回归集：批量回放 + 指标 + HTML 报告
@rr/cli       CLI：record / play / inspect / harness
```

依赖方向：`cli → {recorder, executor, harness}`；`executor → {resolver, ai, schema}`；`recorder → schema`；`resolver → schema`；`harness → {executor, schema}`。**低层不得反向 import 高层。**

## 2. Artifact 目录约定

```
artifacts/
├─ <flowId>/
│  ├─ record/elements/<stepIndex>.png      # 录制时元素裁剪图（crop.ref 相对于本目录）
│  └─ runs/<runId>/
│     ├─ result.json
│     └─ <stepIndex>/{before.png,after.png,element.png,snapshot.json,log.txt}
```

- `ElementRef.crop.ref` 是**相对于 `artifacts/<flowId>/` 的安全相对路径**（schema 已校验）。
- 大文件一律不写进 IR；IR 里只放相对路径。
- `artifacts/` 已在 `.gitignore`。

## 3. Recorder 接口（`@rr/recorder`）

```ts
export interface RecordOptions {
	startUrl: string
	outPath: string
	viewport?: { width: number; height: number } // 默认 1440x900
	headless?: boolean // 默认 false（录制时人工操作）
	artifactsRoot?: string // 默认 ./artifacts
	keepRaw?: boolean // 保留原始事件流到 .raw.json（调试用）
	onStep?: (step: Step) => void // 用于 CLI 打印时间线
	stopSignal?: AbortSignal
	/**
	 * 自动化驱动：给了它就不等人工操作（e2e / 批量录制用）。
	 * 回调拿到 page 与 stop()；回调 resolve 后自动 stop 并落盘。
	 */
	drive?: (page: Page, stop: () => void) => Promise<void>
}

export interface RecordResult {
	flow: Flow
	artifactsDir: string
	rawPath?: string
}

export async function record(opts: RecordOptions): Promise<RecordResult>
```

可单测的纯函数（必须导出并在 `*.test.ts` 覆盖）：

```ts
/** 500ms 缓冲：双击合并、输入合并、滚动合并、导航并入前一步 expect */
export function coalesceEvents(events: RawEvent[], opts?: { bufferMs?: number }): CoalescedAction[]
/** 动作前后签名对比 → 推断 expect（朴素版只出 urlChange / elementVisible） */
export function inferExpect(before: PageSignature, after: PageSignature): Expect | undefined
/** 页面内采集 → 标准化 ObservedFacts / Fingerprint / candidates */
export function buildElementRef(input: RawElementFacts): ElementRef
```

**技术要点**（Spike 结论见 `docs/spikes.md`，未出结论前按保守方案实现）：

- `context.addInitScript({ path: capture.js })` 注入（已确认可进入 OOPIF）；
- `context.exposeBinding('__rrEmit', handler)` 回传事件；`capture.js` 零依赖、纯 JS；
- 页面内**只采事实**（tag/属性白名单/文本/rect/邻近文本/frameId + `stableHash` 所需的原始数据）；候选生成在 Node 侧用 Playwright locator 校验（`getByTestId/getByRole/getByLabel/getByText` 逐个 `count()===1` 且可见）；
- closed shadow 走 CDP `DOM.getDocument({ pierce: true })` + `DOM.getNodeForLocation`；失败则降级"host + 相对偏移"；
- 动作后稳定点：连续 2 帧无布局变化 + 300ms 静默。

## 4. Resolver 接口（`@rr/resolver`）

```ts
export type ResolveLevel = 'L1' | 'L2' | 'L3' | 'L4'

export interface ResolveContext {
	page: Page
	/** AI 兜底（L4），由 executor 注入；null/undefined 表示禁用 */
	repair?: (target: ElementRef, reason: string) => Promise<Locator | null>
	log?: (msg: string) => void
}

export interface ResolveResult {
	locator: Locator
	level: ResolveLevel
	score: number
	ambiguous: boolean
}

export async function resolve(target: ElementRef, ctx: ResolveContext): Promise<ResolveResult>
```

规则（硬性，务必实现）：

- L1：按 `candidates` 顺序逐个尝试，要求 `count()===1` 且 `isVisible()`；命中即返回。
- 多命中时按"候选顺序 + 几何距离（observed.rect）"排序；**top1 与 top2 分差 < 15% 视为 ambiguous，不猜，降级**。
- L2：`stableHash` 精确匹配——页面内按指纹筛元素，打 `data-rr-target=<uid>` 转 Locator，用完删除。
- 所有非 L1 命中都必须在 `ResolveResult` 中标级别，executor 会写进 result.json 与报告。
- 不得吞错：解析不到就抛 `ElementNotFoundError`（executor 负责分类）。

## 5. Executor 接口（`@rr/executor`）

```ts
export interface PlayOptions {
	flow: Flow
	variables?: Record<string, string>
	headless?: boolean // 默认 true
	timeoutMs?: number // 单步默认 15000
	artifactsRoot?: string // 默认 ./artifacts
	ai?: RepairClient | null
	onStep?: (r: StepResult) => void
	runs?: number // 默认 1
}

export interface StepResult {
	stepId: string
	kind: Step['kind']
	status: 'pass' | 'fail' | 'skip'
	level?: ResolveLevel
	ms: number
	error?: { code: ErrorCode; message: string }
}

export type ErrorCode =
	| 'ELEMENT_NOT_FOUND'
	| 'NOT_ACTIONABLE'
	| 'NO_EFFECT'
	| 'EXPECT_MISMATCH'
	| 'NAVIGATION_FAILED'
	| 'DIALOG_UNEXPECTED'
	| 'BROWSER_CRASH'

export interface RunResult {
	flowId: string
	runId: string
	ok: boolean
	steps: StepResult[]
	metrics: { totalMs: number; passCount: number; failCount: number }
}

export async function playFlow(opts: PlayOptions): Promise<RunResult>
export async function playRuns(opts: PlayOptions): Promise<RunResult[]>
```

- `input` 用 `fill`、`click` 先 `{ trial: true }` 再真点、`select` 用 `selectOption`、`upload` 用 `setInputFiles`；
- 失败必须落 artifact（before/after 截图 + snapshot.json + log.txt），错误信息带**语义原因**（不是裸 timeout）；
- `variables` 用 `resolveTemplate` 渲染 `{{var}}`；缺失变量直接失败。

## 6. AI 接口（`@rr/ai`）

```ts
export interface AiConfig {
	baseUrl: string
	apiKey: string
	model: string
	timeoutMs?: number // 默认 8000
	sendScreenshot?: boolean // 默认 false
}

export interface RepairInput {
	url: string
	target: ElementRef
	ariaSnapshot: string // 已截断到 8k
	candidates: Candidate[]
	screenshotPng?: Buffer
}

export interface RepairOutput {
	ref?: string
	confidence: number
	reason: string
}

export interface RepairClient {
	locate(input: RepairInput): Promise<RepairOutput | null>
}

/** 未配置（无环境变量/未启用）时返回 null；executor 据此走纯本地路径 */
export function createRepairClient(cfg?: Partial<AiConfig>): RepairClient | null
export function redact(text: string): string
```

- 默认关闭；只有 `RR_AI_ENABLED=1` 且三个环境变量齐全才返回 client；
- 输出必须是严格 JSON，zod 校验；`ref` 用 `page.getByRef()` 执行；
- 护栏：单步 ≤3 次调用、单 run ≤50 次、同站点连续失败 3 次熔断；缓存 key = `sha1(stableHash + ariaSnapshotHash)`；
- 隐私：`<input type=password>` 的值永不采集；`redact()` 遮蔽邮箱/手机号/身份证/银行卡；
- 自愈写回由 executor 负责（`flow.version++` + `selfHealed[]`，写前备份 `.bak`）。

## 7. Harness 接口（`@rr/harness`）

```ts
export interface SiteSpec {
	id: string
	flowPath: string // flows/<id>.json
	url?: string
	local?: boolean // 本地 fixture 站
}

export interface HarnessReport {
	startedAt: string
	runs: number
	sites: Array<{
		id: string
		runs: Array<{ ok: boolean; passCount: number; failCount: number; totalMs: number }>
		successRate: number
	}>
	stepStats: { p50: number; p95: number }
	levelDistribution: Record<string, number>
	failureCodes: Record<string, number>
}

export async function runHarness(opts: {
	sites: SiteSpec[]
	runs: number
	artifactsRoot?: string
	ai?: RepairClient | null
}): Promise<HarnessReport>

export async function writeHtmlReport(report: HarnessReport, outFile: string): Promise<void>
```

## 8. CLI（`@rr/cli`）

```
rr record --url <url> --out flows/<id>.json [--viewport 1440x900] [--headed|--headless] [--keep-raw]
rr play flows/<id>.json [--runs 3] [--headed] [--ai] [--artifacts ./artifacts]
rr inspect flows/<id>.json          # 打印步骤时间线（含候选/expect/指纹摘要）
rr harness [--runs 10] [--sites local|all] [--out artifacts/harness]
```

- 只用 `node:util.parseArgs`；退出码：0 成功、1 运行失败、2 用法错误；
- 输出用 `picocolors`，中文可读；`--json` 输出机器可读结果（harness 用）。

## 9. 验收命令

```bash
pnpm typecheck      # 0 error
pnpm test           # 单测全绿
pnpm site           # 启动 fixture 站（5173/5174）
pnpm rr --help      # CLI 可用
pnpm harness        # 回归报告（M2 之后才有意义）
```

## 10. Spike 结论对实现的约束（必须先读 docs/spikes.md）

| 场景 | 结论 | 落地方式 |
|---|---|---|
| closed shadow 内层元素 | CDP 能识别内层节点（`getNodeForLocation` / `getDocument({pierce:true})`），但 backendNodeId 不可跨 reload，Playwright selector 与 aria snapshot 都看不见它 | 录制：target=host 的 ElementRef + `observed.shadowRootType:'closed'` + `observed.innerOffset`（取事件 `offsetX/offsetY`）；click 带 `position` 回放 |
| CDP 坐标 | 一律 **CSS px**，不乘 dpr | `DOM.getNodeForLocation` / `Input.dispatchMouseEvent` 直接用 CSS 坐标 |
| iframe 内 aria ref | `page.getByRef('f1e2')` 可直达（同源/跨域/嵌套）；ref 仅对"该 frame 最近一次 ai 快照"有效；导航后前缀变化 | L4 修复拿到 ref 后立即 `getByRef(ref).normalize()` 再执行；期间不得再 `ariaSnapshot()`；`Invalid frame in aria-ref selector` 归类为可重试 |
| closed shadow 与 AI | aria snapshot 完全不包含 closed shadow 内容 | 这类目标跳过 AI 调用，直接 host+position 降级 |

## 11. 多标签页 / 对话框 / 组合键 / 下载 / 上传（v0.2 新增）

IR 扩展（`packages/schema`，24 单测覆盖）：

| 能力 | schema | 约定 |
|---|---|---|
| 多标签页 | 每个 step 可选 `page: { index }`；新 step `switchTab { index }` | index 0 = 录制起点页面，按**创建顺序**编号；录制端在「事件所属 page 与上一步不同」时自动插入 `switchTab`；执行端在切换时 `waitForPage` + `bringToFront()` |
| 原生对话框 | 新 step `dialog { action: 'accept' \| 'dismiss', promptText? }` | 录制端监听 `page.on('dialog')`，自动 accept 并**插在触发它的动作之后**；执行端出现 dialog step 时切到 manual 模式（暂存 pending dialog，由 dialog step 消费） |
| 组合键 | `key` step 新增 `modifiers?: ('Alt'\|'Control'\|'Meta'\|'Shift')[]` | 执行端拼成 `Control+A` 交给 `keyboard.press`/`locator.press`；老 flow 无该字段仍兼容 |
| 下载 | `Expect` 新增 `{ kind: 'download', filenamePattern? }` | 执行端监听 download 并把文件存到 `artifacts/<flowId>/runs/<runId>/downloads/`；`VerifyDeps.recentDownloads()` 提供文件名列表 |
| 上传 | `upload` 的 `files` 支持 `{{file}}` 模板；`Variable.type` 新增 `'file'` | 录制端无法拿到真实文件路径（浏览器限制），记录占位变量；回放时由变量传真实路径，缺变量 → `VARIABLE_MISSING` |
| hover | 复用既有 `hover` step | 录制端只保留"有意义"的 hover：目标有 `aria-haspopup`/`aria-expanded`，或其后 2s 内点击了另一个元素；否则丢弃 |

**已知边界**：iframe 内的 page 归属（目前按顶层 page 计）；窗口级操作（浏览器前进/后退/刷新）仍无 step；关闭标签页没有显式 step（执行端按 page 失效处理）。
