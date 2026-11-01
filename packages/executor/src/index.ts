/**
 * Executor 公共入口（契约见 docs/architecture.md §5）。
 *
 * playFlow：跑一次；playRuns：跑 N 次（每次独立浏览器上下文，避免状态串联）。
 * 自愈写回默认关闭，只有 `writeBack === true`（且提供 flowPath）才动 flow 文件。
 */
import { makeId, saveFlow } from '@rr/schema'

import { applySelfHeals, bumpStats } from './selfheal.js'
import { executeRun } from './run.js'
import type { PlayOptions, RunResult } from './types.js'

export * from './types.js'
export * from './errors.js'
export * from './template.js'
export * from './steps.js'
export * from './selfheal.js'
export * from './url.js'
export { ArtifactWriter, sanitizeSegment } from './artifacts.js'
export { runAction } from './actions.js'
export { executeRun } from './run.js'
export {
	EXPECT_WAIT_MS,
	domSignatureOf,
	pollUntil,
	runAssertion,
	verifyExpect,
} from './verify.js'
export type { VerifyDeps } from './verify.js'
export type { ActionDeps, ActionResult } from './actions.js'
export type { RunOutcome } from './run.js'

/**
 * 跑一次 flow。
 *
 * 自愈写回（计划硬性要求）：
 * - 只有 `opts.writeBack === true` 才写；否则只在 result.json / RunResult.selfHealed 里留痕；
 * - 写回时 `version + 1`、追加 `selfHealed[]`、并 `saveFlow(..., { backup: true })` 留 .bak。
 */
export async function playFlow(opts: PlayOptions): Promise<RunResult> {
	const runId = makeId('run')
	const outcome = await executeRun(opts, runId)

	if (opts.writeBack) {
		if (!opts.flowPath) {
			throw new Error('writeBack=true 时必须提供 flowPath（否则不知道该写回哪个文件）')
		}
		if (outcome.heals.length > 0) {
			// 只写回"能落成候选"的自愈；纯记录型的自愈（无 to）不产生文件变更
			const writable = outcome.heals.filter((heal) => heal.candidate !== undefined)
			if (writable.length > 0) {
				const healed = applySelfHeals(opts.flow, writable)
				const withStats = bumpStats(healed, outcome.result.ok)
				await saveFlow(withStats, opts.flowPath, { backup: true })
				if (outcome.result.flowVersion !== undefined) {
					outcome.result.flowVersion = withStats.version
				}
				opts.onLog?.(
					`自愈写回：${opts.flowPath} v${opts.flow.version} → v${withStats.version}（${writable.length} 条）`,
				)
			}
		}
	} else if (outcome.heals.length > 0) {
		opts.onLog?.(
			`本 run 有 ${outcome.heals.length} 条自愈记录，但 writeBack=false，未写回 flow（传 --write-back 才会写）`,
		)
	}

	return outcome.result
}

/**
 * 跑 N 次（默认 1）。每次都是全新浏览器上下文；写回只在最后一次执行，
 * 避免同一份 flow 被连续 version+1 多次。
 */
export async function playRuns(opts: PlayOptions): Promise<RunResult[]> {
	const runs = Math.max(1, opts.runs ?? 1)
	const results: RunResult[] = []
	for (let index = 0; index < runs; index++) {
		const isLast = index === runs - 1
		results.push(
			await playFlow({
				...opts,
				runs: 1,
				writeBack: opts.writeBack === true && isLast,
			}),
		)
	}
	return results
}
