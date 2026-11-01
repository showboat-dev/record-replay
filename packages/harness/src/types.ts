/**
 * Harness 的类型定义（契约见 docs/architecture.md §7）。
 *
 * 扩展原则：`SiteSpec` / `HarnessReport` 的既有字段一个不改、类型不改宽，harness 需要
 * 额外信息（站点状态、逐站分位、报告落盘位置）全部走**可选字段**——可选字段加不破坏
 * 结构兼容，别人按旧契约读照样编译。
 *
 * 另一条原则：**不静态 import `@rr/executor` 的类型**。executor 正在并行实现，若把它的
 * `RunResult`/`StepResult` 拉进类型层，任何一方改动都会让另一方的 typecheck 变红。
 * 这里用「结构最小集」描述输入输出，真实调用在 `run.ts` 的默认 deps 里做一次受控转换。
 */
import type { RepairClient } from '@rr/ai'

/** 站点在本次回归中的结局 */
export type SiteStatus =
	/** 正常跑完（至少 1 次 run） */
	| 'ok'
	/** 本地站：flow 还没录，什么都没跑 */
	| 'missing'
	/** 公开站：默认不跑（需要联网）/ 还没录 flow */
	| 'skipped'
	/** flow 加载失败或 playRuns 抛错：这次回归没有产出有效数据 */
	| 'failed'

export interface SiteSpec {
	id: string
	flowPath: string
	url?: string
	local?: boolean
	/** 公开站（需要联网）。默认不跑，只有 `--sites all` 且 flow 存在时才真的跑 */
	public?: boolean
}

/**
 * 步骤耗时分位（单位 ms，已四舍五入到整数）。
 * `count` 是参与统计的步骤数——P95 在样本 <20 时基本等于最大值，写明样本量避免误读。
 */
export interface StepStats {
	p50: number
	p95: number
	count?: number
}

export interface SiteRunSummary {
	ok: boolean
	passCount: number
	failCount: number
	totalMs: number
	/** 方便回到 `artifacts/<flowId>/runs/<runId>/` 找 artifact */
	runId?: string
}

export interface HarnessSiteReport {
	id: string
	runs: SiteRunSummary[]
	/** 通过率，**0..1 的小数**（展示时 ×100 并保留 1 位小数） */
	successRate: number
	status?: SiteStatus
	url?: string
	flowPath?: string
	local?: boolean
	public?: boolean
	/** 未跑/失败的原因（status 非 ok 时给人类看） */
	reason?: string
	stepStats?: StepStats
	levelDistribution?: Record<string, number>
	failureCodes?: Record<string, number>
}

/** 没真正跑的站点（missing / skipped），单独列出来便于 CLI/HTML 提示 */
export interface HarnessSkippedSite {
	id: string
	flowPath: string
	status: SiteStatus
	reason: string
}

export interface HarnessReport {
	startedAt: string
	runs: number
	sites: HarnessSiteReport[]
	stepStats: StepStats
	levelDistribution: Record<string, number>
	failureCodes: Record<string, number>
	// ---- 以下是扩展字段（可选，全部有默认值） ----
	finishedAt?: string
	/** 所有站点的 run 汇总（含失败的 run），用于算整体通过率 */
	overallSuccessRate?: number
	totalRuns?: number
	passedRuns?: number
	totalSteps?: number
	skipped?: HarnessSkippedSite[]
	/** report.json 所在的目录（`<artifactsRoot>/harness-<stamp>`） */
	outDir?: string
	reportPath?: string
}

// ---------------------------------------------------------------------------
// executor 接缝：结构最小集（见文件头说明）
// ---------------------------------------------------------------------------

/** 与 `@rr/executor` 的 `StepResult` 结构兼容（多余字段自动忽略） */
export interface StepResultLike {
	stepId?: string
	kind?: string
	status: 'pass' | 'fail' | 'skip'
	/** L1 / L2 / L3 / L4，未命中任何级别时为 undefined */
	level?: string
	ms: number
	error?: { code: string; message?: string }
}

/** 与 `@rr/executor` 的 `RunResult` 结构兼容 */
export interface RunResultLike {
	flowId?: string
	runId?: string
	ok: boolean
	steps: StepResultLike[]
	metrics: { totalMs: number; passCount: number; failCount: number }
}

/** 传给 `playRuns` 的参数（`@rr/executor` 的 `PlayOptions` 的超集/子集交集部分） */
export interface HarnessPlayOptions {
	flow: unknown
	runs: number
	headless: boolean
	artifactsRoot: string
	ai: RepairClient | null
}

export type PlayRunsFn = (opts: HarnessPlayOptions) => Promise<RunResultLike[]>

/** 可注入依赖：单测把 `playRuns` 换成 mock，就不需要真实浏览器 */
export interface HarnessDeps {
	playRuns: PlayRunsFn
	loadFlow: (file: string) => Promise<unknown>
	/** 判断 flow 文件是否存在（默认 `node:fs` 的 existsSync） */
	exists: (absPath: string) => boolean
	now: () => Date
	log: (msg: string) => void
}

export type HarnessProgress =
	| { type: 'site:start'; index: number; total: number; site: SiteSpec }
	| {
			type: 'site:skip'
			index: number
			total: number
			site: SiteSpec
			status: SiteStatus
			reason: string
	  }
	| {
			type: 'site:done'
			index: number
			total: number
			site: SiteSpec
			siteReport: HarnessSiteReport
	  }
	| { type: 'report'; path: string }

export interface RunHarnessOptions {
	sites: SiteSpec[]
	runs: number
	artifactsRoot?: string
	ai?: RepairClient | null
	/** `flows/...` 这类相对路径的解析基准，默认仓库根目录（不是 cwd，避免在子目录里跑就找不到 flow） */
	rootDir?: string
	/** 单测注入点；只覆盖传进来的键，其余用真实实现 */
	deps?: Partial<HarnessDeps>
	onProgress?: (event: HarnessProgress) => void
}
