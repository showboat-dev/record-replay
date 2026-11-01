import { describe, expect, it } from 'vitest'

import type { Flow } from '@rr/schema'

import {
	BatchError,
	buildRowValues,
	exportBatchCsv,
	getBatch,
	resolveMapping,
	startBatch,
	stopBatch,
	type BatchRunner,
	type BatchRunnerInput,
} from './batch.js'

const flow: Flow = {
	schemaVersion: 1,
	id: 'flow_test',
	title: 'test',
	version: 1,
	createdAt: new Date(0).toISOString(),
	meta: {
		env: {
			startUrl: 'http://127.0.0.1:5173/basic',
			viewport: { width: 1440, height: 900 },
			dpr: 1,
		},
		recorder: { name: '@rr/recorder', version: '0.1.0' },
	},
	variables: [
		{ name: 'full_name', type: 'string', secret: false, source: 'input' },
		{ name: 'email', type: 'email', secret: false, source: 'input' },
	],
	steps: [],
	selfHealed: [],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeRunner(
	impl?: (input: BatchRunnerInput, onRow: (index: number, ok: boolean) => void) => Promise<void>,
): BatchRunner & { calls: BatchRunnerInput[] } {
	const calls: BatchRunnerInput[] = []
	return Object.assign(
		async (input: BatchRunnerInput) => {
			calls.push(input)
			if (impl) {
				const rows: BatchRunnerInput['rows'] extends never
					? never
					: Array<{
							index: number
							ok: boolean
							ms: number
							steps: []
						}> = []
				await impl(input, (index, ok) => {
					rows.push({ index, ok, ms: 5, steps: [] })
					input.onRow?.({ index, ok, ms: 5, steps: [] })
				})
				return { rows, stopped: input.signal.aborted }
			}
			return { rows: [], stopped: false }
		},
		{ calls },
	)
}

describe('batch: 列映射', () => {
	it('同名（大小写/空格不敏感）自动匹配', () => {
		const { mapping, missing } = resolveMapping(
			['full_name', 'email'],
			['Full_Name ', 'EMAIL', 'other'],
		)
		expect(mapping).toEqual({ full_name: 'Full_Name ', email: 'EMAIL' })
		expect(missing).toEqual([])
	})

	it('显式映射优先，且支持大小写不敏感选列', () => {
		const { mapping, missing } = resolveMapping(['full_name'], ['姓名', 'Name'], {
			full_name: 'name',
		})
		expect(mapping).toEqual({ full_name: 'Name' })
		expect(missing).toEqual([])
	})

	it('显式映射到不存在的列 → 记入 missing', () => {
		const { missing } = resolveMapping(['a', 'b'], ['x'], { a: 'nope' })
		expect(missing).toEqual(['a', 'b'])
	})

	it('列映射后整形行值，缺列补空串', () => {
		const rows = buildRowValues([{ 姓名: '张三', 邮箱: 'z@x.com' }, { 姓名: '李四' }], {
			full_name: '姓名',
			email: '邮箱',
		})
		expect(rows).toEqual([
			{ index: 1, values: { full_name: '张三', email: 'z@x.com' } },
			{ index: 2, values: { full_name: '李四', email: '' } },
		])
	})
})

describe('batch: 任务状态机', () => {
	it('启动后立即返回 batchId/total/mapping，后台完成后状态 done + 统计正确', async () => {
		const runner = makeRunner(async (input, onRow) => {
			for (const row of input.rows) onRow(row.index, (row.values.full_name ?? '') !== 'bad')
		})
		const started = startBatch({
			batchId: 'b1',
			file: 'f.json',
			flow,
			headers: ['full_name', 'email'],
			csvRows: [
				{ full_name: 'a', email: 'a@x.com' },
				{ full_name: 'bad', email: 'b@x.com' },
				{ full_name: 'c', email: 'c@x.com' },
			],
			artifactsRoot: '/tmp/art',
			runner,
		})
		expect(started).toMatchObject({ total: 3, columns: ['full_name', 'email'] })
		expect(started.mapping).toEqual({ full_name: 'full_name', email: 'email' })
		await sleep(20)
		const job = getBatch('b1')
		expect(job.status).toBe('done')
		expect(job.completed).toBe(3)
		expect(job.okCount).toBe(2)
		expect(job.failCount).toBe(1)
		expect(job.rows.map((r) => r.status)).toEqual(['pass', 'fail', 'pass'])
		expect(job.finishedAt).toBeTypeOf('number')
	})

	it('缺映射列 → BAD_MAPPING；空行 → NO_ROWS', () => {
		const base = {
			batchId: 'b2',
			file: 'f.json',
			flow,
			artifactsRoot: '/tmp/art',
			runner: makeRunner(),
		}
		expect(() =>
			startBatch({ ...base, headers: ['full_name'], csvRows: [{ full_name: 'a' }] }),
		).toThrow(BatchError)
		expect(() => startBatch({ ...base, headers: ['full_name', 'email'], csvRows: [] })).toThrow(
			/没有数据行/,
		)
	})

	it('runner 抛错 → 状态 error + message', async () => {
		const runner: BatchRunner = async () => {
			throw new Error('浏览器崩了')
		}
		startBatch({
			batchId: 'b3',
			file: 'f.json',
			flow,
			headers: ['full_name', 'email'],
			csvRows: [{ full_name: 'a', email: 'a@x.com' }],
			artifactsRoot: '/tmp/art',
			runner,
		})
		await sleep(10)
		const job = getBatch('b3')
		expect(job.status).toBe('error')
		expect(job.message).toContain('浏览器崩了')
	})

	it('stopBatch 中断 → 状态 stopped，结果保留已跑完的行', async () => {
		const runner = makeRunner(async (input, onRow) => {
			onRow(input.rows[0]!.index, true)
			await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve()))
		})
		startBatch({
			batchId: 'b4',
			file: 'f.json',
			flow,
			headers: ['full_name', 'email'],
			csvRows: [
				{ full_name: 'a', email: 'a@x.com' },
				{ full_name: 'b', email: 'b@x.com' },
			],
			artifactsRoot: '/tmp/art',
			runner,
		})
		await sleep(10)
		expect(stopBatch('b4')).toBe(true)
		await sleep(20)
		const job = getBatch('b4')
		expect(job.status).toBe('stopped')
		expect(job.rows[0]!.status).toBe('pass')
		expect(job.rows[1]!.status).toBe('pending')
	})

	it('未知批次 → BATCH_NOT_FOUND', () => {
		expect(() => getBatch('nope')).toThrow(BatchError)
		expect(() => stopBatch('nope')).toThrow(/批次不存在/)
	})
})

describe('batch: 结果导出', () => {
	it('CSV 有 BOM、含原列与状态/失败原因，字段正确转义', async () => {
		const runner = makeRunner(async (input, onRow) => {
			onRow(input.rows[0]!.index, true)
			onRow(input.rows[1]!.index, false)
		})
		startBatch({
			batchId: 'b5',
			file: 'f.json',
			flow,
			headers: ['姓名', '备注'],
			csvRows: [
				{ 姓名: '张三', 备注: '普通' },
				{ 姓名: '李四', 备注: '含,逗号"引号"' },
			],
			mapping: { full_name: '姓名', email: '备注' },
			artifactsRoot: '/tmp/art',
			runner,
		})
		await sleep(20)
		const csv = exportBatchCsv(getBatch('b5'), ['姓名', '备注'])
		expect(csv.startsWith('\ufeff')).toBe(true)
		expect(csv).toContain('行号,姓名,备注,状态,失败步骤,失败原因,耗时ms')
		expect(csv).toContain('"含,逗号""引号"""')
		const lines = csv.split('\r\n').filter(Boolean)
		expect(lines).toHaveLength(3)
	})
})
