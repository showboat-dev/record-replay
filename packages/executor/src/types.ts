/**
 * Executor 公共类型（契约见 docs/architecture.md §5）。
 *
 * 与契约的**唯一一处追加**：`ErrorCode` 增加 `VARIABLE_MISSING`。
 * 理由：变量缺失是"编排错误"，不能伪装成 EXPECT_MISMATCH / NOT_ACTIONABLE，
 * 否则 harness 的 failureCodes 统计会把用户拼错变量名算成页面问题。
 * 其余 7 个错误码与契约完全一致（纯追加，不删除/不改名）。
 */
import type { Flow, Step } from '@rr/schema'

import type { RepairClient } from '@rr/ai'
import type { ResolveLevel } from '@rr/resolver'

export type ErrorCode =
	| 'ELEMENT_NOT_FOUND'
	| 'NOT_ACTIONABLE'
	| 'NO_EFFECT'
	| 'EXPECT_MISMATCH'
	| 'NAVIGATION_FAILED'
	| 'DIALOG_UNEXPECTED'
	| 'BROWSER_CRASH'
	/** 追加：`{{var}}` 缺变量（编排失败，不是页面失败） */
	| 'VARIABLE_MISSING'

export interface StepResult {
	stepId: string
	kind: Step['kind']
	status: 'pass' | 'fail' | 'skip'
	level?: ResolveLevel
	ms: number
	error?: { code: ErrorCode; message: string }
}

export interface RunResult {
	flowId: string
	runId: string
	ok: boolean
	steps: StepResult[]
	metrics: { totalMs: number; passCount: number; failCount: number }
	/** 追加：本次 run 的自愈记录（未写回时也保留，供报告/复核） */
	selfHealed?: SelfHealRecord[]
	/** 追加：artifact 目录（绝对路径） */
	artifactsDir?: string
	/** 追加：flow 版本号（写回后会 +1） */
	flowVersion?: number
}

export type SelfHealLevel = 'L2' | 'L3' | 'L4'

export interface SelfHealRecord {
	stepId: string
	level: SelfHealLevel
	from: string
	to?: string
	confidence?: number
	needsReview: boolean
	at: string
}

export type ScreenshotMode = 'failures' | 'all' | 'off'
export type DialogPolicy = 'dismiss' | 'fail'

export interface PlayOptions {
	flow: Flow
	variables?: Record<string, string>
	/** 默认 true */
	headless?: boolean
	/** 单步默认超时，默认 15000ms */
	timeoutMs?: number
	/** 默认 ./artifacts */
	artifactsRoot?: string
	ai?: RepairClient | null
	onStep?: (r: StepResult) => void
	/** 默认 1 */
	runs?: number
	/** 追加：日志回调（CLI 打印时间线用） */
	onLog?: (msg: string) => void
	/**
	 * 追加：写回所需的 flow 文件路径。
	 * 只有 `writeBack === true` 时才需要；默认不写回（计划硬性要求）。
	 */
	flowPath?: string
	/** 追加：是否把自愈结果写回 flow（默认 false，显式开启） */
	writeBack?: boolean
	/**
	 * 追加：回放环境的 origin 覆盖，例如 `http://127.0.0.1:5173`。
	 * 设置后每步 navigate 的 URL 只替换 origin（保留 path/query/hash），首次 goto 也用它。
	 * harness 通过 SiteSpec.url 传入（录制在 5199、回放在 5173 这类场景）。
	 */
	baseUrl?: string
	/** 追加：截图策略，默认 failures（只在失败步骤落 before/after） */
	screenshotMode?: ScreenshotMode
	/** 追加：出现 JS 对话框时的策略，默认 dismiss（自动关闭并记录） */
	dialogPolicy?: DialogPolicy
	/**
	 * 追加：每步动作前的停顿（ms）。非 headless（给业务人员看）时建议 300–600，
	 * 让"自动填表"看起来像有人在操作，而不是页面一闪而过。
	 */
	stepDelayMs?: number
	/**
	 * 追加：读取登录态（Playwright storageState JSON 路径）。
	 * 文件不存在 / 非法 → 只告警，按"未登录"继续回放（不会让流程跑不起来）。
	 */
	storageStatePath?: string
	/**
	 * 追加：每个 run 结束后把当前登录态**原子写回**该路径（无论成败，尽力而为，失败只告警）。
	 * Studio 负责按 origin 找路径并落文件；core 包只接收路径。
	 */
	saveStorageStatePath?: string
	/**
	 * 追加：解析元素时最多等它出现多久（ms，透传 resolver.elementWaitMs，默认 5000）。
	 * 慢 SPA 调大、追求"失败快速返回"调小（冒烟里用 800 让不存在元素快速失败）。
	 */
	elementWaitMs?: number
	/** 追加：动作前高亮目标元素（非 headless 时建议开），默认 false */
	highlightSteps?: boolean
	/** 追加：非 headless 回放成功结束后，浏览器保持打开的时长（ms），默认 1200 */
	keepOpenMs?: number
	/** 追加：非 headless 回放失败后，浏览器保持打开的时长（ms），默认 15000 */
	keepOpenOnFailureMs?: number
}

/** RunResult 落盘时的扩展结构（result.json） */
export interface RunReport extends RunResult {
	artifactsDir: string
	startedAt: string
	finishedAt: string
	dialogs: string[]
	/** 追加：本次 run 落盘的所有下载文件名（顺序 = 发生顺序） */
	downloads?: string[]
	/** 追加：本次 run 出现过的标签页数量（含起点页） */
	pages?: number
	stepsDetail: StepDetail[]
}

export interface StepDetail {
	stepId: string
	kind: Step['kind']
	status: 'pass' | 'fail' | 'skip'
	level?: ResolveLevel
	score?: number
	ambiguous?: boolean
	resolveReason?: string
	/** 追加：这一步在哪个标签页执行（多标签页流程排障用） */
	pageIndex?: number
	ms: number
	artifactDir?: string
	error?: { code: ErrorCode; message: string }
	log: string[]
}
