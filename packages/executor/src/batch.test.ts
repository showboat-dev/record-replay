/**
 * 批量执行的纯逻辑单测（不启浏览器）：行循环控制、聚合、失败步骤提取、artifact 相对路径。
 * 真实浏览器场景见 batch.smoke.test.ts（RR_SMOKE=1 才跑）。
 */
import { describe, expect, it, vi } from 'vitest'

import { artifactRelativePath, pickFailedStep, runBatchRows, summarizeBatch } from './index.js'
import type { BatchRow, BatchRowResult, StepResult } from './index.js'

function row(index: number, values: Record<string, string> = { name: `v${index}` }): BatchRow {
	return { values, index }
}

function rowResult(index: number, ok = true, extra: Partial<BatchRowResult> = {}): BatchRowResult {
	return { index, ok, runId: `run-${index}`, ms: 10, steps: [], ...extra }
}

function stepResult(overrides: Partial<StepResult> = {}): StepResult {
	return {
		stepId: 's1',
		kind: 'input',
		status: 'pass',
		ms: 5,
		...overrides,
	}
}

describe('executor: batch 聚合', () => {
	it('okCount/failCount/total/totalMs/stopped 正确', () => {
		const result = summarizeBatch({
			rows: [rowResult(1, true), rowResult(2, false), rowResult(3, true)],
			total: 3,
			stopped: false,
			totalMs: 123,
		})
		expect(result).toMatchObject({ total: 3, okCount: 2, failCount: 1, stopped: false, totalMs: 123 })
	})

	it('空行数组 → 全 0，不算失败', () => {
		const result = summarizeBatch({ rows: [], total: 0, stopped: false, totalMs: 0 })
		expect(result).toMatchObject({ total: 0, okCount: 0, failCount: 0, stopped: false })
	})

	it('中断时 failCount 只算已跑过的行（未跑的不算失败）', () => {
		const result = summarizeBatch({
			rows: [rowResult(1, true), rowResult(2, false)],
			total: 10,
			stopped: true,
			totalMs: 50,
		})
		expect(result.failCount).toBe(1)
		expect(result.total).toBe(10)
		expect(result.stopped).toBe(true)
	})
})

describe('executor: 行循环（runBatchRows）', () => {
	it('全部成功：顺序与输入一致，onRow 逐行实时回调', async () => {
		const seen: number[] = []
		const rows = [row(1), row(2), row(3)]
		const result = await runBatchRows({
			rows,
			runRow: async (r) => {
				seen.push(r.index)
				return rowResult(r.index)
			},
			onRow: (r) => seen.push(100 + r.index),
		})
		expect(seen).toEqual([1, 101, 2, 102, 3, 103])
		expect(result.rows.map((r) => r.index)).toEqual([1, 2, 3])
		expect(result).toMatchObject({ okCount: 3, failCount: 0, stopped: false, total: 3 })
	})

	it('runRow 收到的行数据是原始 rows（变量映射结果）', async () => {
		const captured: Record<string, string>[] = []
		await runBatchRows({
			rows: [row(1, { name: '张三', email: 'a@b.com' })],
			runRow: async (r) => {
				captured.push(r.values)
				return rowResult(r.index)
			},
		})
		expect(captured).toEqual([{ name: '张三', email: 'a@b.com' }])
	})

	it('stopOnFailure=true：首行失败即停，后续行不跑', async () => {
		const ran: number[] = []
		const result = await runBatchRows({
			rows: [row(1), row(2), row(3)],
			stopOnFailure: true,
			runRow: async (r) => {
				ran.push(r.index)
				return rowResult(r.index, r.index !== 2)
			},
		})
		expect(ran).toEqual([1, 2])
		expect(result.stopped).toBe(true)
		expect(result.rows).toHaveLength(2)
		expect(result).toMatchObject({ okCount: 1, failCount: 1, total: 3 })
	})

	it('stopOnFailure=false（默认）：失败行不中断，后续继续', async () => {
		const ran: number[] = []
		const result = await runBatchRows({
			rows: [row(1), row(2), row(3)],
			runRow: async (r) => {
				ran.push(r.index)
				return rowResult(r.index, r.index !== 2)
			},
		})
		expect(ran).toEqual([1, 2, 3])
		expect(result.stopped).toBe(false)
		expect(result).toMatchObject({ okCount: 2, failCount: 1 })
	})

	it('信号在开跑前已 abort → 一行都不跑，stopped=true', async () => {
		const controller = new AbortController()
		controller.abort()
		const ran: number[] = []
		const result = await runBatchRows({
			rows: [row(1), row(2)],
			signal: controller.signal,
			runRow: async (r) => {
				ran.push(r.index)
				return rowResult(r.index)
			},
		})
		expect(ran).toEqual([])
		expect(result.stopped).toBe(true)
		expect(result.rows).toEqual([])
		expect(result.total).toBe(2)
	})

	it('跑完第 1 行后 abort → 返回已跑完的 1 行，stopped=true', async () => {
		const controller = new AbortController()
		const ran: number[] = []
		const result = await runBatchRows({
			rows: [row(1), row(2), row(3)],
			signal: controller.signal,
			runRow: async (r) => {
				ran.push(r.index)
				controller.abort() // 模拟"用户点了停止"
				return rowResult(r.index)
			},
		})
		expect(ran).toEqual([1])
		expect(result.stopped).toBe(true)
		expect(result.rows).toHaveLength(1)
	})

	it('行级异常不会炸整批：映射成该行失败（code 来自 classifyError），后续照跑', async () => {
		const result = await runBatchRows({
			rows: [row(1), row(2)],
			runRow: async (r) => {
				if (r.index === 1) throw new Error('Target page, context or browser has been closed')
				return rowResult(r.index)
			},
		})
		expect(result.rows[0]).toMatchObject({ index: 1, ok: false })
		expect(result.rows[0]?.failedStep).toMatchObject({ code: 'BROWSER_CRASH' })
		expect(result.rows[1]).toMatchObject({ index: 2, ok: true })
		expect(result).toMatchObject({ okCount: 1, failCount: 1 })
	})

	it('rowDelayMs：只在行间等待，最后一行后不再等', async () => {
		const sleeps: number[] = []
		await runBatchRows({
			rows: [row(1), row(2), row(3)],
			rowDelayMs: 250,
			runRow: async (r) => rowResult(r.index),
			sleep: async (ms) => {
				sleeps.push(ms)
			},
		})
		expect(sleeps).toEqual([250, 250]) // 3 行之间只有 2 次间隔
	})

	it('rowDelayMs 且被 stopOnFailure 中断时不再额外等待', async () => {
		const sleeps: number[] = []
		await runBatchRows({
			rows: [row(1), row(2)],
			rowDelayMs: 100,
			stopOnFailure: true,
			runRow: async (r) => rowResult(r.index, false),
			sleep: async (ms) => {
				sleeps.push(ms)
			},
		})
		expect(sleeps).toEqual([])
	})

	it('空 rows → 立即返回全 0 结果，不调用 runRow', async () => {
		const runRow = vi.fn()
		const result = await runBatchRows({ rows: [], runRow })
		expect(runRow).not.toHaveBeenCalled()
		expect(result).toMatchObject({ total: 0, okCount: 0, failCount: 0, stopped: false, rows: [] })
	})
})

describe('executor: 失败步骤提取（failedStep）', () => {
	it('全部通过 → undefined', () => {
		expect(pickFailedStep([stepResult(), stepResult()])).toBeUndefined()
	})

	it('取第一个失败步骤的 id/kind/code/reason', () => {
		const steps = [
			stepResult(),
			stepResult({
				stepId: 'fill-email',
				kind: 'input',
				status: 'fail',
				error: { code: 'VARIABLE_MISSING', message: '变量渲染失败：缺少变量 "email"' },
			}),
			stepResult({ stepId: 'later', status: 'fail', error: { code: 'NO_EFFECT', message: 'x' } }),
		]
		expect(pickFailedStep(steps)).toEqual({
			id: 'fill-email',
			kind: 'input',
			code: 'VARIABLE_MISSING',
			reason: '变量渲染失败：缺少变量 "email"',
		})
	})

	it('缺变量场景 reason 里能看出是哪个变量（批量失败原因要给人看）', () => {
		const failed = pickFailedStep([
			stepResult({
				stepId: 's2',
				status: 'fail',
				error: { code: 'VARIABLE_MISSING', message: '变量渲染失败：缺少变量 "email"' },
			}),
		])
		expect(failed?.reason).toContain('email')
		expect(failed?.code).toBe('VARIABLE_MISSING')
	})

	it('失败但没有 error 对象时不崩（只有 id/kind）', () => {
		expect(pickFailedStep([stepResult({ status: 'fail' })])).toEqual({ id: 's1', kind: 'input' })
	})
})

describe('executor: artifact 相对路径', () => {
	it('转成 posix 分隔符（Studio 直接拼 /artifacts/ URL）', () => {
		expect(artifactRelativePath('/tmp/artifacts', '/tmp/artifacts/flow/batches/b1/row-2/1/after.png')).toBe(
			'flow/batches/b1/row-2/1/after.png',
		)
	})
})
