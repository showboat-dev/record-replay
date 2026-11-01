/**
 * 批量执行（一次录好、把 CSV 里 200 行都跑掉）。契约见 docs/batch-run.md §B。
 *
 * 设计要点：
 * - **浏览器只启动一次**：每行新建 context（带 storageState）→ 行间 cookie/localStorage 天然隔离；
 * - 行级 artifacts：`artifacts/<flowId>/batches/<batchId>/row-<index>/`（失败步骤自己的
 *   `before/after/snapshot/log` 由现有 run 逻辑落盘，这里额外写行级 `result.json` + `log.txt`）；
 * - 行内 `VARIABLE_MISSING`（renderStep 抛错）只是**该行失败**，整批继续；
 * - 循环控制与聚合是纯函数（`runBatchRows` / `summarizeBatch` / `pickFailedStep`），便于单测；
 * - `signal` 中断的粒度是"行间"：当前行会跑完（最多受单步超时约束），然后 `stopped: true` 返回已跑完的行。
 */
import { existsSync } from 'node:fs'
import { relative as pathRelative } from 'node:path'

import { chromium, type Browser } from 'playwright'

import { makeId, type Flow } from '@rr/schema'

import { ArtifactWriter } from './artifacts.js'
import { classifyError } from './errors.js'
import { runFlowInBrowserContext } from './run.js'
import type { StepResult } from './types.js'

/* ------------------------------------------------------------------ */
/* 契约类型（docs/batch-run.md §B）                                     */
/* ------------------------------------------------------------------ */

/** 已按变量名映射好的一行数据（缺列补 ''） */
export interface BatchRow {
	values: Record<string, string>
	/** 原始行号（CSV 第几行数据，1-based），用于结果展示与 artifact 目录名 */
	index: number
}

export interface BatchOptions {
	flow: Flow
	rows: BatchRow[]
	/** 默认 true */
	headless?: boolean
	/** 默认 false：某行失败后继续跑剩余行 */
	stopOnFailure?: boolean
	/** 行间隔（默认 0） */
	rowDelayMs?: number
	artifactsRoot?: string
	/** 登录态文件（每行 context 都带上） */
	storageStatePath?: string
	/** 每个 context 的 viewport 覆盖（默认 flow.meta.env.viewport） */
	viewport?: { width: number; height: number }
	onRow?: (result: BatchRowResult) => void
	signal?: AbortSignal
	/** 追加：单步超时（透传 executor，默认 15000） */
	timeoutMs?: number
	/** 追加：日志回调（Studio 用来显示实时进度） */
	onLog?: (msg: string) => void
	/** 追加：固定 batchId（Studio 自生成，便于先返回 id 再轮询）；默认自动生成 */
	batchId?: string
}

export interface BatchRowResult {
	index: number
	ok: boolean
	runId: string
	ms: number
	steps: StepResult[]
	failedStep?: { id: string; kind: string; code?: string; reason?: string }
	/** 失败行的 after 截图（artifacts 相对路径，posix 分隔符） */
	screenshot?: string
	/** 追加：该行 artifact 目录（相对 artifactsRoot 的 posix 路径，Studio 拼 URL 用） */
	rowArtifactsPath?: string
}

export interface BatchResult {
	total: number
	okCount: number
	failCount: number
	stopped: boolean
	rows: BatchRowResult[]
	totalMs: number
	/** 追加：本批 id（artifact 目录名，Studio 轮询/导出要用） */
	batchId?: string
	/** 追加：本批 artifact 根目录（绝对路径） */
	artifactsDir?: string
}

/* ------------------------------------------------------------------ */
/* 纯逻辑：行循环 / 聚合 / 失败步骤提取                                  */
/* ------------------------------------------------------------------ */

/** 从步骤结果里挑出第一个失败步骤（VARIABLE_MISSING 的 reason 里会带变量名） */
export function pickFailedStep(
	steps: StepResult[],
): { id: string; kind: string; code?: string; reason?: string } | undefined {
	const failed = steps.find((step) => step.status === 'fail')
	if (!failed) return undefined
	return {
		id: failed.stepId,
		kind: failed.kind,
		...(failed.error?.code ? { code: failed.error.code } : {}),
		...(failed.error?.message ? { reason: failed.error.message } : {}),
	}
}

/** 聚合批次结果（纯函数，便于单测） */
export function summarizeBatch(input: {
	rows: BatchRowResult[]
	total: number
	stopped: boolean
	totalMs: number
}): BatchResult {
	const okCount = input.rows.filter((row) => row.ok).length
	return {
		total: input.total,
		okCount,
		failCount: input.rows.length - okCount,
		stopped: input.stopped,
		rows: input.rows,
		totalMs: input.totalMs,
	}
}

/** 把绝对路径转成 artifacts 相对路径（posix 分隔符，方便拼 URL） */
export function artifactRelativePath(root: string, absolutePath: string): string {
	const rel = pathRelative(root, absolutePath)
	return rel.split('\\').join('/')
}

export interface BatchRowLoopInput {
	rows: BatchRow[]
	/** 跑一行；抛异常会被归类成"该行失败"而不是让整批崩掉 */
	runRow: (row: BatchRow, rowOrdinal: number) => Promise<BatchRowResult>
	stopOnFailure?: boolean
	rowDelayMs?: number
	onRow?: (result: BatchRowResult) => void
	signal?: AbortSignal
	/** 注入 sleep（单测用），默认 setTimeout */
	sleep?: (ms: number) => Promise<void>
	/** 最近一次已跑到的时间（默认 now） */
	now?: () => number
}

/**
 * 行循环（纯控制流，不碰浏览器）：
 * - 行前检查 abort；行级异常 → 该行失败（code 用 classifyError 映射），继续/停止按 stopOnFailure；
 * - `onRow` 每行完成立刻回调（Studio 实时进度）；
 * - 行间 `rowDelayMs`（最后一行/中断时不等待）。
 */
export async function runBatchRows(input: BatchRowLoopInput): Promise<BatchResult> {
	const startedAt = (input.now ?? Date.now)()
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	const rows: BatchRowResult[] = []
	let stopped = false

	for (const row of input.rows) {
		if (input.signal?.aborted) {
			stopped = true
			break
		}
		let result: BatchRowResult
		try {
			result = await input.runRow(row, rows.length)
		} catch (err) {
			// 行级异常（例如浏览器崩了）：归到这一行，不影响批次控制流
			const classified = classifyError(err, 'framework')
			result = {
				index: row.index,
				ok: false,
				runId: makeId('row'),
				ms: 0,
				steps: [],
				failedStep: { id: '<row>', kind: 'batch', code: classified.code, reason: classified.message },
			}
		}
		rows.push(result)
		input.onRow?.(result)

		if (!result.ok && input.stopOnFailure) {
			stopped = true
			break
		}
		const moreRows = rows.length < input.rows.length
		if (input.rowDelayMs && input.rowDelayMs > 0 && moreRows && !input.signal?.aborted) {
			await sleep(input.rowDelayMs)
		}
	}

	return summarizeBatch({
		rows,
		total: input.rows.length,
		stopped,
		totalMs: (input.now ?? Date.now)() - startedAt,
	})
}

/* ------------------------------------------------------------------ */
/* playBatch：一次浏览器 + 每行一个 context                             */
/* ------------------------------------------------------------------ */

function failedStepScreenshot(
	root: string,
	rowArtifacts: ArtifactWriter,
	outcomeSteps: StepResult[],
): string | undefined {
	const failedIndex = outcomeSteps.findIndex((step) => step.status === 'fail')
	if (failedIndex < 0) return undefined
	// run 逻辑把每一步的证据写在 <rowDir>/<stepIndex>/after.png
	const candidate = `${rowArtifacts.runDir}/${failedIndex}/after.png` // 仅用于拼绝对路径
	if (!existsSync(candidate)) return undefined
	return artifactRelativePath(root, candidate)
}

async function launchBrowser(headless: boolean): Promise<Browser> {
	return chromium.launch({ headless })
}

export async function playBatch(opts: BatchOptions): Promise<BatchResult> {
	const flow = opts.flow
	const batchId = opts.batchId ?? makeId('batch')
	const artifactsRoot = opts.artifactsRoot ?? './artifacts'
	const batchDir = ArtifactWriter.batchRoot(artifactsRoot, flow.id, batchId)
	const log = (msg: string): void => opts.onLog?.(`[batch ${batchId}] ${msg}`)

	// 空行数组：不启动浏览器（Studio 侧也可能是 0 行 CSV 的边界场景）
	if (opts.rows.length === 0) {
		return {
			...summarizeBatch({ rows: [], total: 0, stopped: false, totalMs: 0 }),
			batchId,
			artifactsDir: batchDir,
		}
	}

	log(`开始批量：${opts.rows.length} 行，stopOnFailure=${opts.stopOnFailure === true}`)
	const browser = await launchBrowser(opts.headless ?? true)

	try {
		const result = await runBatchRows({
			rows: opts.rows,
			...(opts.stopOnFailure !== undefined ? { stopOnFailure: opts.stopOnFailure } : {}),
			...(opts.rowDelayMs !== undefined ? { rowDelayMs: opts.rowDelayMs } : {}),
			...(opts.onRow ? { onRow: opts.onRow } : {}),
			...(opts.signal ? { signal: opts.signal } : {}),
			runRow: async (row) => {
				const runId = makeId(`row${row.index}`)
				const rowArtifacts = new ArtifactWriter(artifactsRoot, flow.id, runId, {
					kind: 'batches',
					batchId,
					rowIndex: row.index,
				})
				const rowStart = Date.now()
				const logLines: string[] = []
				const pushLog = (msg: string): void => {
					logLines.push(msg)
					opts.onLog?.(`[row ${row.index}] ${msg}`)
				}
				log(`row ${row.index} 开始（${Object.keys(row.values).length} 个变量）`)

				const outcome = await runFlowInBrowserContext({
					browser,
					flow,
					opts: {
						flow,
						// 行数据覆盖 flow 里的变量默认值
						variables: { ...row.values },
						headless: opts.headless ?? true,
						...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
						artifactsRoot,
						...(opts.storageStatePath ? { storageStatePath: opts.storageStatePath } : {}),
						// 行级失败要留证据；成功行按 failures 规则不落截图
						screenshotMode: 'failures',
					},
					artifacts: rowArtifacts,
					runId,
					pushLog,
					runStart: rowStart,
					...(opts.viewport ? { viewport: opts.viewport } : {}),
				})

				const failedStep = pickFailedStep(outcome.steps)
				const ok = failedStep === undefined && outcome.steps.length > 0
				const ms = Date.now() - rowStart
				const screenshot = ok
					? undefined
					: failedStepScreenshot(artifactsRoot, rowArtifacts, outcome.steps)
				const rowResult: BatchRowResult = {
					index: row.index,
					ok,
					runId,
					ms,
					steps: outcome.steps,
					...(failedStep ? { failedStep } : {}),
					...(screenshot ? { screenshot } : {}),
					rowArtifactsPath: artifactRelativePath(artifactsRoot, rowArtifacts.runDir),
				}

				// 行级证据：result.json（含 stepsDetail）+ log.txt
				try {
					await rowArtifacts.writeResult({
						...rowResult,
						rowValues: row.values,
						dialogs: outcome.dialogs,
						downloads: outcome.downloads,
						pages: outcome.pages,
						stepsDetail: outcome.details,
					})
					await rowArtifacts.writeText('log.txt', `${logLines.join('\n')}\n`)
				} catch (err) {
					log(`row ${row.index} artifact 落盘失败：${(err as Error).message}`)
				}

				log(
					ok
						? `row ${row.index} ✓ ${ms}ms`
						: `row ${row.index} ✗ ${failedStep?.code ?? 'FAIL'}：${failedStep?.reason ?? ''}`,
				)
				return rowResult
			},
		})

		return {
			...result,
			batchId,
			artifactsDir: batchDir,
		}
	} finally {
		await browser.close().catch(() => {
			/* 浏览器可能已被外部关闭 */
		})
	}
}
