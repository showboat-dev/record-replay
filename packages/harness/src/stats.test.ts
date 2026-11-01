import { describe, expect, it } from 'vitest'

import {
	collectStepDurations,
	countFailureCodes,
	countLevels,
	flattenSteps,
	formatPercent,
	mergeCounts,
	percentile,
	percentileOf,
	round,
	sortedEntries,
	successRate,
	summarizeSite,
	toRunSummary,
	toStepStats,
} from './index.js'
import type { RunResultLike, StepResultLike } from './types.js'

function step(overrides: Partial<StepResultLike> = {}): StepResultLike {
	return { status: 'pass', ms: 10, level: 'L1', ...overrides }
}

function run(
	ok: boolean,
	steps: StepResultLike[],
	totalMs: number,
	runId = 'run_1',
): RunResultLike {
	const passCount = steps.filter((s) => s.status === 'pass').length
	const failCount = steps.filter((s) => s.status === 'fail').length
	return {
		flowId: 'flow_1',
		runId,
		ok,
		steps,
		metrics: { totalMs, passCount, failCount },
	}
}

describe('percentile', () => {
	it('空样本返回 0（不返回 NaN）', () => {
		expect(percentile([], 50)).toBe(0)
		expect(toStepStats([])).toEqual({ p50: 0, p95: 0, count: 0 })
	})

	it('单样本任何分位都是它自己', () => {
		expect(percentile([7], 0)).toBe(7)
		expect(percentile([7], 50)).toBe(7)
		expect(percentile([7], 100)).toBe(7)
	})

	it('R-7 线性插值：p0/p50/p95/p100 都对', () => {
		const sorted = [1, 2, 3, 4]
		expect(percentile(sorted, 0)).toBe(1)
		expect(percentile(sorted, 50)).toBe(2.5)
		expect(percentile(sorted, 95)).toBeCloseTo(3.85, 10)
		expect(percentile(sorted, 100)).toBe(4)
	})

	it('越界的分位会被夹到 0..100', () => {
		expect(percentile([1, 2, 3], -50)).toBe(1)
		expect(percentile([1, 2, 3], 500)).toBe(3)
	})

	it('percentileOf 接受乱序输入（内部排序，不改原数组）', () => {
		const values = [30, 10, 20]
		expect(percentileOf(values, 50)).toBe(20)
		expect(values).toEqual([30, 10, 20])
	})
})

describe('toStepStats', () => {
	it('ms 四舍五入到整数，并带上样本量', () => {
		// sorted = [10,20,30,40,50] → p50 = 30, p95 = 40 + 10*0.8 = 48
		const stats = toStepStats([10, 20, 30, 40, 50])
		expect(stats).toEqual({ p50: 30, p95: 48, count: 5 })
	})

	it('count 为 0 时 p50/p95 都是 0', () => {
		expect(toStepStats([]).p50).toBe(0)
	})
})

describe('collectStepDurations', () => {
	it('跳过 skip 步骤（skip 的 ms 往往是 0，会把分位拉低）', () => {
		const steps = [
			step({ ms: 10 }),
			step({ status: 'skip', ms: 0 }),
			step({ status: 'pass', ms: 30 }),
			step({ status: 'fail', ms: 20 }),
		]
		expect(collectStepDurations(steps)).toEqual([10, 30, 20])
	})
})

describe('successRate', () => {
	it('没有 run 时为 0', () => {
		expect(successRate([])).toBe(0)
	})

	it('2/3 通过 → 0.6667（4 位小数）', () => {
		expect(
			successRate([
				{ ok: true, passCount: 1, failCount: 0, totalMs: 1 },
				{ ok: true, passCount: 1, failCount: 0, totalMs: 1 },
				{ ok: false, passCount: 0, failCount: 1, totalMs: 1 },
			]),
		).toBe(0.6667)
	})

	it('全通过 = 1，全失败 = 0', () => {
		expect(successRate([{ ok: true, passCount: 1, failCount: 0, totalMs: 1 }])).toBe(1)
		expect(successRate([{ ok: false, passCount: 0, failCount: 1, totalMs: 1 }])).toBe(0)
	})
})

describe('countLevels / countFailureCodes', () => {
	it('级别分布只统计有 level 的步骤', () => {
		const steps = [
			step({ level: 'L1' }),
			step({ level: 'L1' }),
			step({ level: 'L2' }),
			step({ level: 'L3' }),
			step({ level: undefined }),
		]
		expect(countLevels(steps)).toEqual({ L1: 2, L2: 1, L3: 1 })
	})

	it('失败码只统计 fail 且带 code 的步骤', () => {
		const steps = [
			step({ status: 'fail', error: { code: 'ELEMENT_NOT_FOUND' } }),
			step({ status: 'fail', error: { code: 'NO_EFFECT' } }),
			step({ status: 'fail', error: { code: 'NO_EFFECT' } }),
			step({ status: 'fail' }),
			step({ status: 'pass', error: { code: 'EXPECT_MISMATCH' } }),
		]
		expect(countFailureCodes(steps)).toEqual({ ELEMENT_NOT_FOUND: 1, NO_EFFECT: 2 })
	})

	it('没有数据时返回空对象（不是 undefined）', () => {
		expect(countLevels([])).toEqual({})
		expect(countFailureCodes([])).toEqual({})
	})
})

describe('mergeCounts / sortedEntries / round / formatPercent', () => {
	it('mergeCounts 累加而不是覆盖', () => {
		const target: Record<string, number> = { L1: 2 }
		mergeCounts(target, { L1: 3, L2: 1 })
		mergeCounts(target, { L2: 2 })
		expect(target).toEqual({ L1: 5, L2: 3 })
	})

	it('sortedEntries 按次数降序、次数相同按 key 升序（报告稳定可 diff）', () => {
		expect(sortedEntries({ B: 1, A: 1, C: 5 })).toEqual([
			['C', 5],
			['A', 1],
			['B', 1],
		])
	})

	it('round 去掉浮点尾巴', () => {
		expect(round(0.1 + 0.2, 4)).toBe(0.3)
		expect(round(2 / 3, 4)).toBe(0.6667)
	})

	it('formatPercent 输出百分比字符串', () => {
		expect(formatPercent(1)).toBe('100.0%')
		expect(formatPercent(0.9583)).toBe('95.8%')
		expect(formatPercent(0, 0)).toBe('0%')
	})
})

describe('toRunSummary / flattenSteps', () => {
	it('RunResult → 报告里的 run 摘要（含 runId，方便找 artifact）', () => {
		const summary = toRunSummary(
			run(true, [step()], 123, 'run_abc'),
		)
		expect(summary).toEqual({
			ok: true,
			passCount: 1,
			failCount: 0,
			totalMs: 123,
			runId: 'run_abc',
		})
	})

	it('没有 runId 时不写该字段（报告更干净）', () => {
		const result = run(true, [step()], 1)
		delete result.runId
		expect(toRunSummary(result)).not.toHaveProperty('runId')
	})

	it('flattenSteps 保持 run 顺序', () => {
		const steps = flattenSteps([
			run(true, [step({ ms: 1 }), step({ ms: 2 })], 3),
			run(true, [step({ ms: 3 })], 3),
		])
		expect(steps.map((s) => s.ms)).toEqual([1, 2, 3])
	})
})

describe('summarizeSite', () => {
	it('把多次 run 汇总成站点报告（成功率 / 分位 / 分布）', () => {
		const results = [
			run(true, [step({ ms: 10 }), step({ ms: 20 }), step({ level: 'L2', ms: 30 })], 60, 'r1'),
			run(
				false,
				[
					step({ ms: 40 }),
					step({ status: 'fail', level: 'L2', ms: 50, error: { code: 'NO_EFFECT' } }),
					step({ status: 'skip', ms: 0 }),
				],
				90,
				'r2',
			),
		]
		const site = summarizeSite('local-basic', results, { url: 'http://127.0.0.1:5173/basic' })
		expect(site.id).toBe('local-basic')
		expect(site.status).toBe('ok')
		expect(site.url).toBe('http://127.0.0.1:5173/basic')
		expect(site.runs).toHaveLength(2)
		expect(site.successRate).toBe(0.5)
		// 非 skip 步骤：[10,20,30,40,50] → p50 30 / p95 48
		expect(site.stepStats).toEqual({ p50: 30, p95: 48, count: 5 })
		expect(site.levelDistribution).toEqual({ L1: 3, L2: 2 })
		expect(site.failureCodes).toEqual({ NO_EFFECT: 1 })
	})

	it('允许覆盖 status 等字段（runHarness 用来标 failed）', () => {
		const site = summarizeSite('local-spa', [], { status: 'failed', reason: 'boom' })
		expect(site.status).toBe('failed')
		expect(site.reason).toBe('boom')
		expect(site.successRate).toBe(0)
	})
})
