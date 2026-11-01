/**
 * `rr harness` 与 `pnpm harness` 的共同实现（两个 CLI 入口只负责解析参数）。
 *
 * 为什么要有这一层：两个入口的用法文本不同，但"选站点 → 跑 → 写 HTML → 打摘要 → 算退出码"
 * 必须完全一致，否则迟早出现"`pnpm harness` 全绿但 `rr harness` 红"的幽灵问题。
 */
import type { RepairClient } from '@rr/ai'

import { htmlReportPath, writeHtmlReport } from './html.js'
import { runHarness } from './run.js'
import { selectSites, type SiteMode } from './sites.js'
import { formatHarnessSummary } from './summary.js'
import type { HarnessDeps, HarnessReport, SiteSpec } from './types.js'
import { harnessFailed, harnessFailureReason } from './verdict.js'

export interface HarnessCommandOptions {
	/** 站点集合（默认 `'local'`，即 11 条本地站） */
	sites?: SiteSpec[] | SiteMode
	/** 每站跑几次（默认 1） */
	runs?: number
	/** artifact 根目录 / 报告根目录（默认 `<仓库根>/artifacts`） */
	artifactsRoot?: string
	ai?: RepairClient | null
	/** 单测注入点 */
	deps?: Partial<HarnessDeps>
	/** 人话输出落点（默认 console.log） */
	print?: (line: string) => void
	/** true 时不打印摘要（调用方要自己输出 JSON） */
	quiet?: boolean
	/** 是否写 HTML 报告（默认 true） */
	html?: boolean
}

export interface HarnessCommandResult {
	report: HarnessReport
	/** 0 = 全绿 / 1 = 有回归或无法运行 */
	exitCode: number
	reportPath?: string
	htmlPath?: string
	/** 已排版好的摘要行（调用方想自己打印时用） */
	summary: string[]
}

/**
 * 跑一轮 harness。**不调用 `process.exit`**：返回 exitCode 由调用方决定，便于单测。
 * 抛错只发生在参数非法（runs < 1 等）——站点级失败会被 runHarness 吞进报告。
 */
export async function runHarnessCommand(
	opts: HarnessCommandOptions = {},
): Promise<HarnessCommandResult> {
	const selection = opts.sites ?? 'local'
	const sites: SiteSpec[] = typeof selection === 'string' ? selectSites(selection) : selection

	const report = await runHarness({
		sites,
		runs: opts.runs ?? 1,
		...(opts.artifactsRoot ? { artifactsRoot: opts.artifactsRoot } : {}),
		ai: opts.ai ?? null,
		...(opts.deps ? { deps: opts.deps } : {}),
	})

	let htmlPath: string | undefined
	if (opts.html !== false) {
		htmlPath = htmlReportPath(report)
		await writeHtmlReport(report, htmlPath)
	}

	const summary = formatHarnessSummary(report)
	const failed = harnessFailed(report)
	if (failed) summary.push(`回归未通过：${harnessFailureReason(report)}`)

	if (!opts.quiet) {
		const print = opts.print ?? ((line: string) => console.log(line))
		for (const line of summary) print(line)
	}

	const result: HarnessCommandResult = { report, exitCode: failed ? 1 : 0, summary }
	if (report.reportPath) result.reportPath = report.reportPath
	if (htmlPath) result.htmlPath = htmlPath
	return result
}
