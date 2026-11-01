/**
 * CSV 批量执行的任务管理（docs/batch-run.md §C）。
 *
 * 设计：
 * - 真正的逐行执行交给 `@rr/executor` 的 `playBatch`（浏览器只启动一次，行级隔离）；
 * - 这里只负责：列映射、行数据整形、任务状态机、进度快照、结果 CSV 导出；
 * - runner 可注入（便于单测，不依赖浏览器）。
 */
import type { Flow } from '@rr/schema'

export interface BatchRowValues {
	/** CSV 数据行号（1-based，不含表头） */
	index: number
	values: Record<string, string>
}

/** 一行的原始 CSV 值（导出结果时用原列名） */
export type RawRow = Record<string, string>

export interface BatchRowSnapshot {
	index: number
	raw: RawRow
	status: 'pending' | 'running' | 'pass' | 'fail'
	ms?: number
	failedStep?: { id: string; kind: string; code?: string; reason?: string }
	screenshot?: string
}

export type BatchStatus = 'running' | 'done' | 'stopped' | 'error'

export interface BatchJobSnapshot {
	batchId: string
	file: string
	flowId: string
	/** CSV 原始表头（结果导出列顺序） */
	headers: string[]
	status: BatchStatus
	total: number
	completed: number
	okCount: number
	failCount: number
	rows: BatchRowSnapshot[]
	startedAt: number
	finishedAt?: number
	message?: string
}

/** 行级结果（由执行的 runner 产出，字段与 executor BatchRowResult 对齐） */
export interface BatchRowResultLike {
	index: number
	ok: boolean
	ms: number
	steps: Array<{
		stepId: string
		kind: string
		status: string
		error?: { code?: string; message?: string }
	}>
	failedStep?: { id: string; kind: string; code?: string; reason?: string }
	screenshot?: string
}

export interface BatchRunnerInput {
	flow: Flow
	rows: BatchRowValues[]
	headless: boolean
	stopOnFailure: boolean
	rowDelayMs: number
	artifactsRoot: string
	storageStatePath?: string
	onRow?: (row: BatchRowResultLike) => void
	signal: AbortSignal
}

export interface BatchRunnerOutput {
	rows: BatchRowResultLike[]
	stopped: boolean
}

export type BatchRunner = (input: BatchRunnerInput) => Promise<BatchRunnerOutput>

export type BatchErrorCode = 'BAD_MAPPING' | 'NO_ROWS' | 'BATCH_NOT_FOUND'

export class BatchError extends Error {
	readonly code: BatchErrorCode
	constructor(code: BatchErrorCode, message: string) {
		super(message)
		this.name = 'BatchError'
		this.code = code
	}
}

export interface StartBatchInput {
	batchId: string
	file: string
	flow: Flow
	/** 解析后的 CSV（headers + rows + warnings） */
	headers: string[]
	csvRows: RawRow[]
	mapping?: Record<string, string>
	options?: { headless?: boolean; stopOnFailure?: boolean; rowDelayMs?: number }
	artifactsRoot: string
	storageStatePath?: string
	runner: BatchRunner
}

export interface StartBatchOutput {
	batchId: string
	total: number
	columns: string[]
	mapping: Record<string, string>
	missingVariables: string[]
}

interface BatchJob {
	snapshot: BatchJobSnapshot
	controller: AbortController
}

/** 进程内任务表（Studio 重启即丢，v1 可接受） */
const jobs = new Map<string, BatchJob>()
const MAX_JOBS = 20

/** 变量 → CSV 列 的映射解析：显式映射优先；否则同名（大小写/空格不敏感）自动匹配 */
export function resolveMapping(
	variables: string[],
	columns: string[],
	provided?: Record<string, string>,
): { mapping: Record<string, string>; missing: string[] } {
	const byLower = new Map<string, string>()
	for (const column of columns) byLower.set(column.trim().toLowerCase(), column)
	const mapping: Record<string, string> = {}
	const missing: string[] = []
	for (const variable of variables) {
		const explicit = provided?.[variable]
		if (explicit) {
			const column =
				columns.find((c) => c === explicit) ?? byLower.get(explicit.trim().toLowerCase())
			if (column) {
				mapping[variable] = column
				continue
			}
			missing.push(variable)
			continue
		}
		const column = byLower.get(variable.trim().toLowerCase())
		if (column) mapping[variable] = column
		else missing.push(variable)
	}
	return { mapping, missing }
}

/** 按映射把 CSV 行整形成"变量名 → 值"（缺列补空串） */
export function buildRowValues(rows: RawRow[], mapping: Record<string, string>): BatchRowValues[] {
	return rows.map((raw, i) => {
		const values: Record<string, string> = {}
		for (const [variable, column] of Object.entries(mapping)) values[variable] = raw[column] ?? ''
		return { index: i + 1, values }
	})
}

/** 启动一批：立即返回 batchId，后台逐行执行；进度通过快照查询 */
export function startBatch(input: StartBatchInput): StartBatchOutput {
	const variables = input.flow.variables.map((v) => v.name)
	const { mapping, missing } = resolveMapping(variables, input.headers, input.mapping)
	if (missing.length) {
		throw new BatchError('BAD_MAPPING', `CSV 里缺少这些参数列：${missing.join('、')}，请重新映射`)
	}
	if (!input.csvRows.length) throw new BatchError('NO_ROWS', 'CSV 里没有数据行（只有表头或为空）')

	const rowValues = buildRowValues(input.csvRows, mapping)
	const controller = new AbortController()
	const snapshot: BatchJobSnapshot = {
		batchId: input.batchId,
		file: input.file,
		flowId: input.flow.id,
		headers: input.headers,
		status: 'running',
		total: rowValues.length,
		completed: 0,
		okCount: 0,
		failCount: 0,
		rows: input.csvRows.map((raw, i) => ({
			index: i + 1,
			raw,
			status: 'pending' as const,
		})),
		startedAt: Date.now(),
	}
	jobs.set(input.batchId, { snapshot, controller })
	cleanupOldJobs()

	const rowIndexByCsvIndex = new Map(snapshot.rows.map((row) => [row.index, row]))

	void (async () => {
		try {
			const result = await input.runner({
				flow: input.flow,
				rows: rowValues,
				headless: input.options?.headless ?? true,
				stopOnFailure: input.options?.stopOnFailure ?? false,
				rowDelayMs: input.options?.rowDelayMs ?? 0,
				artifactsRoot: input.artifactsRoot,
				...(input.storageStatePath ? { storageStatePath: input.storageStatePath } : {}),
				signal: controller.signal,
				onRow: (row) => applyRowResult(snapshot, rowIndexByCsvIndex, row),
			})
			for (const row of result.rows) applyRowResult(snapshot, rowIndexByCsvIndex, row)
			snapshot.status = controller.signal.aborted ? 'stopped' : 'done'
			snapshot.finishedAt = Date.now()
		} catch (err) {
			snapshot.status = controller.signal.aborted ? 'stopped' : 'error'
			snapshot.message = `批量执行出错：${(err as Error).message}`
			snapshot.finishedAt = Date.now()
		}
	})()

	return {
		batchId: input.batchId,
		total: rowValues.length,
		columns: input.headers,
		mapping,
		missingVariables: missing,
	}
}

function applyRowResult(
	snapshot: BatchJobSnapshot,
	rowIndexByCsvIndex: Map<number, BatchRowSnapshot>,
	row: BatchRowResultLike,
): void {
	const target = rowIndexByCsvIndex.get(row.index)
	if (!target) return
	if (target.status === 'pass' || target.status === 'fail') return // 幂等：onRow 与最终结果可能重复
	target.status = row.ok ? 'pass' : 'fail'
	target.ms = row.ms
	if (row.failedStep) target.failedStep = row.failedStep
	if (row.screenshot) target.screenshot = row.screenshot
	snapshot.completed = snapshot.rows.filter(
		(r) => r.status === 'pass' || r.status === 'fail',
	).length
	snapshot.okCount = snapshot.rows.filter((r) => r.status === 'pass').length
	snapshot.failCount = snapshot.rows.filter((r) => r.status === 'fail').length
}

export function stopBatch(batchId: string): boolean {
	const job = jobs.get(batchId)
	if (!job) throw new BatchError('BATCH_NOT_FOUND', '批次不存在')
	if (job.snapshot.status !== 'running') return false
	job.snapshot.message = '已请求停止，正在结束当前行…'
	job.controller.abort()
	return true
}

export function getBatch(batchId: string): BatchJobSnapshot {
	const job = jobs.get(batchId)
	if (!job) throw new BatchError('BATCH_NOT_FOUND', '批次不存在')
	return job.snapshot
}

function cleanupOldJobs(): void {
	if (jobs.size <= MAX_JOBS) return
	const finished = [...jobs.entries()]
		.filter(([, job]) => job.snapshot.status !== 'running')
		.sort((a, b) => a[1].snapshot.startedAt - b[1].snapshot.startedAt)
	for (const [id] of finished) {
		if (jobs.size <= MAX_JOBS) break
		jobs.delete(id)
	}
}

const STATUS_TEXT: Record<string, string> = { pass: '成功', fail: '失败', pending: '未执行' }

function csvCell(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** 结果 CSV（UTF-8 BOM，Excel 直接打开不乱码）；列：原列 + 状态/失败步骤/失败原因/耗时 */
export function exportBatchCsv(snapshot: BatchJobSnapshot, headers: string[]): string {
	const columns = ['行号', ...headers, '状态', '失败步骤', '失败原因', '耗时ms']
	const lines = [columns.map(csvCell).join(',')]
	for (const row of snapshot.rows) {
		const status = row.status === 'pass' || row.status === 'fail' ? STATUS_TEXT[row.status]! : ''
		lines.push(
			[
				String(row.index),
				...headers.map((h) => row.raw[h] ?? ''),
				status,
				row.failedStep?.id ?? '',
				row.failedStep?.reason ?? row.failedStep?.code ?? '',
				row.ms === undefined ? '' : String(row.ms),
			]
				.map(csvCell)
				.join(','),
		)
	}
	return `\ufeff${lines.join('\r\n')}\r\n`
}
