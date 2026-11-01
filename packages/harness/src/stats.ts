/**
 * 统计计算（纯函数，全部可单测）。
 *
 * 指标口径（写死在代码里，避免"报告里的数怎么来的"说不清）：
 * - **成功率**：`ok === true` 的 run 数 / 总 run 数，输出 0..1 的小数，保留 4 位。
 * - **步骤 P50/P95**：把**所有站点的所有 run** 的非 skip 步骤耗时拍平后取分位，
 *   输出 ms 整数（四舍五入）。失败的步骤也计入——超时步骤会把 P95 顶上去，这正是
 *   回归集想让人看见的信号。
 * - **命中级别分布**：对每个步骤统计它的 `level`（L1/L2/L3/L4）。L3/L4 占比升高 =
 *   语义定位在退化，是 M2 之后最重要的趋势指标。
 * - **失败码分布**：只统计 `status === 'fail'` 且带 `error.code` 的步骤次数。
 */
import type {
	HarnessSiteReport,
	RunResultLike,
	SiteRunSummary,
	StepResultLike,
	StepStats,
} from './types.js'

/**
 * 分位数（R-7 / 线性插值，与 numpy 默认、Excel PERCENTILE.INC 一致）。
 * @param sortedAsc 已升序排序的样本
 * @param p 0..100
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
	const n = sortedAsc.length
	if (n === 0) return 0
	if (n === 1) return sortedAsc[0] ?? 0
	const clamped = Math.min(100, Math.max(0, p))
	const rank = (clamped / 100) * (n - 1)
	const lower = Math.floor(rank)
	const upper = Math.ceil(rank)
	const low = sortedAsc[lower] ?? 0
	const high = sortedAsc[upper] ?? low
	return low + (high - low) * (rank - lower)
}

/** 分位数（内部先排序，不要求调用方有序） */
export function percentileOf(values: readonly number[], p: number): number {
	return percentile([...values].sort((a, b) => a - b), p)
}

/** 把一组步骤耗时汇总成分位；空样本返回全 0 而不是 NaN */
export function toStepStats(msValues: readonly number[]): StepStats {
	const sorted = [...msValues].sort((a, b) => a - b)
	return {
		p50: Math.round(percentile(sorted, 50)),
		p95: Math.round(percentile(sorted, 95)),
		count: sorted.length,
	}
}

/** 参与耗时统计的步骤：跳过 skip（它的 ms 通常是 0，会把分位拉低） */
export function collectStepDurations(steps: readonly StepResultLike[]): number[] {
	return steps.filter((step) => step.status !== 'skip').map((step) => step.ms)
}

/** 通过率 0..1，四舍五入到 4 位；没有 run 时为 0 */
export function successRate(runs: readonly SiteRunSummary[]): number {
	if (runs.length === 0) return 0
	const passed = runs.filter((run) => run.ok).length
	return round(passed / runs.length, 4)
}

/**
 * 命中级别分布。
 * 只统计**真的尝试解析过**的步骤：skip 步骤没有解析过程，即便带着 level 也不计
 * （与 `collectStepDurations` 的口径保持一致，否则两处统计的样本集不一样）。
 */
export function countLevels(steps: readonly StepResultLike[]): Record<string, number> {
	const counts: Record<string, number> = {}
	for (const step of steps) {
		if (step.status === 'skip' || !step.level) continue
		counts[step.level] = (counts[step.level] ?? 0) + 1
	}
	return counts
}

/** 失败码分布（只统计 fail 且带 code 的步骤） */
export function countFailureCodes(steps: readonly StepResultLike[]): Record<string, number> {
	const counts: Record<string, number> = {}
	for (const step of steps) {
		if (step.status !== 'fail') continue
		const code = step.error?.code
		if (!code) continue
		counts[code] = (counts[code] ?? 0) + 1
	}
	return counts
}

/** 把 src 的计数累加进 target（用于把逐站分布合成全局分布） */
export function mergeCounts(target: Record<string, number>, src: Record<string, number>): void {
	for (const [key, value] of Object.entries(src)) target[key] = (target[key] ?? 0) + value
}

/** executor 的 RunResult → 报告里的 run 摘要 */
export function toRunSummary(result: RunResultLike): SiteRunSummary {
	const summary: SiteRunSummary = {
		ok: result.ok === true,
		passCount: result.metrics.passCount,
		failCount: result.metrics.failCount,
		totalMs: result.metrics.totalMs,
	}
	if (result.runId) summary.runId = result.runId
	return summary
}

/** 一个站点全部 run 的步骤拍平（顺序保持，便于复现） */
export function flattenSteps(results: readonly RunResultLike[]): StepResultLike[] {
	return results.flatMap((result) => result.steps)
}

/** 把一次站点的多次 run 汇总成报告里的 `HarnessSiteReport` */
export function summarizeSite(
	id: string,
	results: readonly RunResultLike[],
	extra: Partial<HarnessSiteReport> = {},
): HarnessSiteReport {
	const runs = results.map(toRunSummary)
	const steps = flattenSteps(results)
	return {
		id,
		runs,
		successRate: successRate(runs),
		status: 'ok',
		stepStats: toStepStats(collectStepDurations(steps)),
		levelDistribution: countLevels(steps),
		failureCodes: countFailureCodes(steps),
		...extra,
	}
}

/** 0.9583 → "95.8%" */
export function formatPercent(rate: number, digits = 1): string {
	return `${(rate * 100).toFixed(digits)}%`
}

/** 计数 Map 按值降序（稳居第一的失败码排前面；值相同按 key 字典序，保证报告稳定） */
export function sortedEntries(counts: Record<string, number>): Array<[string, number]> {
	return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** 保留 n 位小数（避免浮点尾巴进 JSON） */
export function round(value: number, digits: number): number {
	const factor = 10 ** digits
	return Math.round(value * factor) / factor
}
