/**
 * 回归集执行器（`docs/architecture.md` §7 的唯一实现）。
 *
 * 流程：逐站检查 flow 是否存在 → 存在则 `playRuns` → 汇总指标 → 落 `report.json`。
 *
 * 两个刻意的设计：
 * 1. **依赖注入**（`opts.deps`）：默认用真实的 `@rr/executor` / `@rr/schema`，单测把
 *    `playRuns` 换成 mock 就能在几毫秒内测完整个统计链路，不需要浏览器。
 * 2. **executor 的类型不进入类型层**（见 types.ts 文件头）：并行开发时互不阻塞。
 *
 * 失败语义：单个站点失败（flow 读不出来 / playRuns 抛错）**不中断整轮回归**，
 * 记为 `status: 'failed'` 继续跑下一个站，最后靠 `harnessFailed()` 决定退出码。
 * 这是回归集的正确姿势——一个站炸了不该让另外 10 个站的数据丢失。
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { REPO_ROOT, formatStamp, resolveFromRoot } from './paths.js'
import {
	collectStepDurations,
	flattenSteps,
	mergeCounts,
	round,
	summarizeSite,
	toStepStats,
} from './stats.js'
import type {
	HarnessDeps,
	HarnessPlayOptions,
	HarnessProgress,
	HarnessReport,
	HarnessSiteReport,
	HarnessSkippedSite,
	RunHarnessOptions,
	RunResultLike,
	SiteSpec,
	SiteStatus,
	StepResultLike,
} from './types.js'

/** 报告目录前缀：`<artifactsRoot>/harness-<stamp>/` */
export const HARNESS_DIR_PREFIX = 'harness-'

/** 默认 `playRuns`：真实 executor（动态 import，避免顶层就把并行开发中的包拉进来） */
async function defaultPlayRuns(opts: HarnessPlayOptions): Promise<RunResultLike[]> {
	const mod = (await import('@rr/executor')) as unknown as {
		playRuns: (o: HarnessPlayOptions) => Promise<RunResultLike[]>
	}
	return await mod.playRuns(opts)
}

/** 默认 `loadFlow`：schema 的 `loadFlow`（会做 zod + 契约校验） */
async function defaultLoadFlow(file: string): Promise<unknown> {
	const mod = (await import('@rr/schema')) as unknown as {
		loadFlow: (f: string) => Promise<unknown>
	}
	return await mod.loadFlow(file)
}

function resolveDeps(overrides: Partial<HarnessDeps> | undefined): HarnessDeps {
	return {
		playRuns: defaultPlayRuns,
		loadFlow: defaultLoadFlow,
		exists: (absPath) => existsSync(absPath),
		now: () => new Date(),
		log: () => {},
		...overrides,
	}
}

/** `runs` 校验：必须是 >= 1 的整数（NaN / 0 / 1.5 / 负数一律拒绝） */
export function normalizeRunCount(runs: unknown): number {
	const value = Number(runs)
	if (typeof runs === 'boolean' || !Number.isInteger(value) || value < 1) {
		throw new Error(`runs 必须是 >= 1 的整数，收到：${String(runs)}`)
	}
	return value
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

/** 没有真正跑过任何一次的站点（missing / skipped / failed） */
function emptySiteReport(site: SiteSpec, status: SiteStatus, reason: string): HarnessSiteReport {
	const report: HarnessSiteReport = {
		id: site.id,
		runs: [],
		successRate: 0,
		status,
		reason,
	}
	if (site.url !== undefined) report.url = site.url
	report.flowPath = site.flowPath
	if (site.local !== undefined) report.local = site.local
	if (site.public !== undefined) report.public = site.public
	return report
}

function emit(onProgress: RunHarnessOptions['onProgress'], event: HarnessProgress): void {
	if (!onProgress) return
	try {
		onProgress(event)
	} catch {
		// 进度回调只是 UI，报错不能影响回归本身
	}
}

/**
 * 跑一轮回归，返回报告，并把 `report.json` 写到
 * `<artifactsRoot>/harness-<YYYYMMDD-HHmmss>/report.json`。
 *
 * `artifactsRoot` 省略时用 `<仓库根>/artifacts`；显式传入的相对路径按 `process.cwd()` 解析（Node 常规语义）。
 */
export async function runHarness(opts: RunHarnessOptions): Promise<HarnessReport> {
	const deps = resolveDeps(opts.deps)
	const rootDir = opts.rootDir ?? REPO_ROOT
	const runs = normalizeRunCount(opts.runs)
	const started = deps.now()
	const artifactsRoot = opts.artifactsRoot
		? resolve(opts.artifactsRoot)
		: join(rootDir, 'artifacts')
	const outDir = join(artifactsRoot, `${HARNESS_DIR_PREFIX}${formatStamp(started)}`)

	const sites = opts.sites ?? []
	const siteReports: HarnessSiteReport[] = []
	const skipped: HarnessSkippedSite[] = []
	const allSteps: StepResultLike[] = []
	const levelDistribution: Record<string, number> = {}
	const failureCodes: Record<string, number> = {}
	let totalRuns = 0
	let passedRuns = 0

	for (let index = 0; index < sites.length; index += 1) {
		const site = sites[index]
		if (!site) continue
		const total = sites.length
		const absFlow = resolveFromRoot(site.flowPath, rootDir)

		// 1) flow 不存在：不报错，标状态继续 —— "还没录"和"录了但跑挂了"要能区分
		if (!deps.exists(absFlow)) {
			const status: SiteStatus = site.public ? 'skipped' : 'missing'
			const reason =
				status === 'skipped'
					? '公开站未录制 flow（默认不联网；仅 --sites all 且 flow 存在时才跑）'
					: `flow 不存在：${site.flowPath}`
			skipped.push({ id: site.id, flowPath: site.flowPath, status, reason })
			siteReports.push(emptySiteReport(site, status, reason))
			emit(opts.onProgress, { type: 'site:skip', index, total, site, status, reason })
			continue
		}

		emit(opts.onProgress, { type: 'site:start', index, total, site })

		let siteReport: HarnessSiteReport
		try {
			const flow = await deps.loadFlow(absFlow)
			const results = await deps.playRuns({
				flow,
				runs,
				headless: true,
				artifactsRoot,
				ai: opts.ai ?? null,
				// flow 录制时的 origin 可能与当前回放环境不同（端口/环境切换）：按站点 url 重定基
				...(site.url ? { baseUrl: site.url } : {}),
				// public 站的 flow 常带 secret 变量（如 {{password}}）：从 RR_VAR_<name> 环境变量注入
				...(() => {
					const variables = collectEnvVariables()
					return Object.keys(variables).length ? { variables } : {}
				})(),
			})
			if (!Array.isArray(results) || results.length === 0) {
				throw new Error('playRuns 没有返回任何结果（executor 尚未实现？）')
			}
			const steps = flattenSteps(results)
			allSteps.push(...steps)
			siteReport = summarizeSite(site.id, results, {
				url: site.url,
				flowPath: site.flowPath,
				local: site.local,
				public: site.public,
			})
			totalRuns += siteReport.runs.length
			passedRuns += siteReport.runs.filter((run) => run.ok).length
			mergeCounts(levelDistribution, siteReport.levelDistribution ?? {})
			mergeCounts(failureCodes, siteReport.failureCodes ?? {})
		} catch (error) {
			const reason = errorMessage(error)
			deps.log(`[harness] ${site.id} 失败：${reason}`)
			siteReport = emptySiteReport(site, 'failed', reason)
		}

		siteReports.push(siteReport)
		emit(opts.onProgress, { type: 'site:done', index, total, site, siteReport })
	}

	const finished = deps.now()
	const reportPath = join(outDir, 'report.json')
	const report: HarnessReport = {
		startedAt: started.toISOString(),
		runs,
		sites: siteReports,
		stepStats: toStepStats(collectStepDurations(allSteps)),
		levelDistribution,
		failureCodes,
		finishedAt: finished.toISOString(),
		overallSuccessRate: totalRuns === 0 ? 0 : round(passedRuns / totalRuns, 4),
		totalRuns,
		passedRuns,
		totalSteps: allSteps.length,
		skipped,
		outDir,
		reportPath,
	}

	await mkdir(outDir, { recursive: true })
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
	emit(opts.onProgress, { type: 'report', path: reportPath })
	return report
}

/** 从 `RR_VAR_<name>` 环境变量收集 flow 变量（public 站回放用，避免把 secret 写进仓库） */
export function collectEnvVariables(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith('RR_VAR_') || value === undefined) continue
		const name = key.slice('RR_VAR_'.length)
		if (name) out[name] = value
	}
	return out
}
