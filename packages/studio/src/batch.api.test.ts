/**
 * CSV 批量执行 API 测试：mock @rr/executor 的 playBatch（不启浏览器），
 * 验证路由契约、行状态聚合、缺列 400、停止、结果导出。
 */
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadFlow, saveFlow, type Flow } from '@rr/schema'

import type { BatchRowResult } from '@rr/executor'

vi.mock('@rr/executor', async () => {
	const actual = await vi.importActual<typeof import('@rr/executor')>('@rr/executor')
	return {
		...actual,
		playBatch: vi.fn(
			async (opts: {
				rows: Array<{ index: number; values: Record<string, string> }>
				onRow?: (r: BatchRowResult) => void
				signal?: AbortSignal
				stopOnFailure?: boolean
				rowDelayMs?: number
			}) => {
				const rows: BatchRowResult[] = []
				for (const row of opts.rows) {
					if (opts.signal?.aborted) break
					const ok = row.values.full_name !== 'bad'
					const result: BatchRowResult = {
						index: row.index,
						ok,
						runId: `run-${row.index}`,
						ms: 5,
						steps: [],
						...(ok
							? {}
							: {
									failedStep: {
										id: 's1',
										kind: 'input',
										code: 'EXPECT_MISMATCH',
										reason: '页面没有出现预期变化',
									},
								}),
					}
					rows.push(result)
					opts.onRow?.(result)
					await new Promise((r) => setTimeout(r, 5))
				}
				return {
					batchId: 'mock',
					total: opts.rows.length,
					okCount: rows.filter((r) => r.ok).length,
					failCount: rows.filter((r) => !r.ok).length,
					stopped: opts.signal?.aborted ?? false,
					rows,
					totalMs: 1,
				}
			},
		),
	}
})

const repoFlows = join(import.meta.dirname, '..', '..', '..', 'flows')

let dir: string
let base: string
let close: () => Promise<void>
let flowsDir: string

async function makeBatchFlow(): Promise<void> {
	const file = join(flowsDir, 'batch-flow.json')
	await mkdir(flowsDir, { recursive: true })
	const source = await loadFlow(join(repoFlows, 'local-basic.json'))
	const flow: Flow = structuredClone(source)
	flow.id = 'flow_batch_test'
	flow.title = 'batch'
	flow.variables = [
		{ name: 'full_name', type: 'string', secret: false, source: 'input' },
		{ name: 'email', type: 'email', secret: false, source: 'input' },
	]
	flow.steps = flow.steps.map((step, i) => {
		if (i === 0 && step.kind === 'input') return { ...step, value: '{{full_name}}' }
		if (i === 1 && step.kind === 'input') return { ...step, value: '{{email}}' }
		return step
	})
	await saveFlow(flow, file)
}

async function api(
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: any; text: string }> {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
	})
	const text = await res.text()
	let body: any = null
	try {
		body = JSON.parse(text)
	} catch {
		/* csv 等非 JSON 响应 */
	}
	return { status: res.status, body, text }
}

const start = (
	csvText: string,
	mapping?: Record<string, string>,
	options?: Record<string, unknown>,
) =>
	api('/api/flows/batch-flow.json/batch/start', {
		method: 'POST',
		body: JSON.stringify({
			csvText,
			...(mapping ? { mapping } : {}),
			...(options ? { options } : {}),
		}),
	})

async function waitDone(batchId: string): Promise<any> {
	for (let i = 0; i < 100; i++) {
		const res = await api(`/api/batches/${batchId}`)
		if (res.body.status !== 'running') return res.body
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error('批次超时未完成')
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'rr-batch-api-'))
	flowsDir = join(dir, 'flows')
	await mkdir(flowsDir, { recursive: true })
	await cp(join(repoFlows, 'local-basic.json'), join(flowsDir, 'local-basic.json'))
	await makeBatchFlow()
	const { createStudioServer } = await import('@rr/studio')
	const server = await createStudioServer({
		port: 0,
		flowsDir,
		artifactsDir: join(dir, 'artifacts'),
		profilesDir: join(dir, 'profiles'),
	})
	base = `http://127.0.0.1:${server.port}`
	close = server.close
})
afterEach(async () => {
	await close?.()
	await rm(dir, { recursive: true, force: true })
})

describe('batch API', () => {
	it('正常跑 3 行：2 成功 1 失败，进度与结果正确', async () => {
		const started = await start('full_name,email\nalice,a@x.com\nbad,b@x.com\nc,c@x.com')
		expect(started.status, JSON.stringify(started.body)).toBe(200)
		expect(started.body).toMatchObject({
			total: 3,
			columns: ['full_name', 'email'],
			mapping: { full_name: 'full_name', email: 'email' },
			missingVariables: [],
		})
		const job = await waitDone(started.body.batchId)
		expect(job.status).toBe('done')
		expect(job).toMatchObject({ total: 3, completed: 3, okCount: 2, failCount: 1 })
		expect(job.rows.map((r: any) => r.status)).toEqual(['pass', 'fail', 'pass'])
		expect(job.rows[1].failedStep.reason).toContain('预期')
	})

	it('缺列 → 400 BAD_MAPPING；空数据行 → 400 NO_ROWS；未知批次 → 404', async () => {
		const missing = await start('full_name\nalice')
		expect(missing.status).toBe(400)
		expect(missing.body.code).toBe('BAD_MAPPING')
		expect(missing.body.error).toContain('email')

		const empty = await start('full_name,email\n')
		expect(empty.status).toBe(400)
		expect(empty.body.code).toBe('NO_ROWS')

		expect((await api('/api/batches/nope')).status).toBe(404)
		expect((await api('/api/batches/nope', { method: 'POST' })).status).toBe(404)
	})

	it('显式 mapping 可用（列名与变量名不同）', async () => {
		const started = await start('姓名,邮箱\n张三,z@x.com', { full_name: '姓名', email: '邮箱' })
		expect(started.status).toBe(200)
		expect(started.body.mapping).toEqual({ full_name: '姓名', email: '邮箱' })
		const job = await waitDone(started.body.batchId)
		expect(job.okCount).toBe(1)
	})

	it('停止：running 批次可停，状态 stopped', async () => {
		const longCsv = [
			'full_name,email',
			...Array.from({ length: 30 }, (_, i) => `n${i},e${i}@x.com`),
		].join('\n')
		const started = await start(longCsv)
		expect(started.status).toBe(200)
		expect(
			(await api(`/api/batches/${started.body.batchId}/stop`, { method: 'POST' })).status,
		).toBe(200)
		const job = await waitDone(started.body.batchId)
		expect(job.status).toBe('stopped')
	})

	it('导出结果 CSV：BOM + 原列 + 状态/失败原因', async () => {
		const started = await start('full_name,email\nalice,a@x.com\nbad,b@x.com')
		await waitDone(started.body.batchId)
		const raw = await fetch(`${base}/api/batches/${started.body.batchId}/export.csv`).then((r) =>
			r.arrayBuffer(),
		)
		const bytes = new Uint8Array(raw)
		// UTF-8 BOM
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
		const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw)
		expect(text.startsWith('\ufeff')).toBe(true)
		expect(text).toContain('行号,full_name,email,状态,失败步骤,失败原因,耗时ms')
		expect(text).toContain('成功')
		expect(text).toContain('失败')
	})
})
