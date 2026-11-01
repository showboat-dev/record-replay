/**
 * 终端摘要（`pnpm harness` / `rr harness` 共用的"人话"输出）。
 *
 * 纯函数返回 `string[]`，不直接 console.log：
 * - 方便单测断言具体每一行（传 `{ color: false }` 去掉 ANSI 转义）；
 * - 两个 CLI 入口（packages/harness/src/cli.ts 与 packages/cli/src/main.ts）复用同一份
 *   排版，避免两个入口的输出慢慢长歪。
 */
import pc from 'picocolors'

import { formatPercent, sortedEntries } from './stats.js'
import type { HarnessReport, HarnessSiteReport } from './types.js'

export interface SummaryOptions {
	/** false 时输出不含 ANSI（单测/重定向到文件） */
	color?: boolean
	/** 最多列多少个失败码（避免一屏刷爆） */
	maxFailureCodes?: number
}

const ID_WIDTH = 24

/** 只依赖用到的那几个 formatter，避免依赖 picocolors 的内部类型路径 */
type Colorizer = Pick<typeof pc, 'bold' | 'dim' | 'red' | 'green' | 'yellow'>

function padEndVisible(text: string, width: number): string {
	// 只按字符数补齐（id 都是 ASCII，够用；中文不参与补齐）
	return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function ms(value: number | undefined): string {
	if (value === undefined || Number.isNaN(value)) return '—'
	return `${Math.round(value)}ms`
}

function siteLine(site: HarnessSiteReport, c: Colorizer): string {
	const id = padEndVisible(site.id, ID_WIDTH)
	if (site.status !== 'ok') {
		const label = site.status === 'failed' ? '无法运行' : site.status === 'skipped' ? '跳过' : '缺 flow'
		return `  ${c.dim('·')} ${id} ${c.dim(`${label}：${site.reason ?? ''}`)}`
	}
	const runsOk = site.runs.filter((run) => run.ok).length
	const allPassed = site.successRate >= 1
	const mark = allPassed ? c.green('✓') : c.red('✗')
	// 先 padEnd 再上色：ANSI 转义不参与宽度计算，否则列会歪
	const rateText = formatPercent(site.successRate).padEnd(7)
	const rate = allPassed ? c.green(rateText) : c.red(rateText)
	const runs = `${runsOk}/${site.runs.length}`.padEnd(7)
	const p50 = ms(site.stepStats?.p50).padEnd(7)
	const p95 = ms(site.stepStats?.p95).padEnd(7)
	const codes = sortedEntries(site.failureCodes ?? {})
		.slice(0, 3)
		.map(([code, count]) => `${code}×${count}`)
		.join(' ')
	return `  ${mark} ${id} ${runs} ${rate} p50 ${p50} p95 ${p95}${codes ? ` ${c.dim(codes)}` : ''}`
}

/** 报告 → 终端摘要行（含逐站表格、级别/失败码分布、报告路径、复现命令） */
export function formatHarnessSummary(
	report: HarnessReport,
	opts: SummaryOptions = {},
): string[] {
	const c = opts.color === false ? pc.createColors(false) : pc
	const maxCodes = opts.maxFailureCodes ?? 8
	const lines: string[] = []

	const okSites = report.sites.filter((site) => site.status === 'ok')
	const missing = report.sites.filter((site) => site.status === 'missing' || site.status === 'skipped')
	const failed = report.sites.filter((site) => site.status === 'failed')

	lines.push('')
	lines.push(
		`${c.bold('harness')} ${c.dim('·')} ${c.dim(report.startedAt)} → ${c.dim(report.finishedAt ?? '未完成')}`,
	)
	lines.push(
		`站点 ${c.bold(String(okSites.length))}/${report.sites.length} 跑完` +
			` · runs ${c.bold(String(report.totalRuns ?? 0))}（每站 ${report.runs} 次）` +
			(missing.length ? ` · 缺 flow ${c.yellow(String(missing.length))}` : '') +
			(failed.length ? ` · 无法运行 ${c.red(String(failed.length))}` : ''),
	)

	const overall = report.overallSuccessRate ?? 0
	const overallText = formatPercent(overall)
	lines.push(
		`通过 ${overall >= 1 ? c.green(overallText) : c.red(overallText)}` +
			`（${report.passedRuns ?? 0}/${report.totalRuns ?? 0} runs）` +
			` · 步骤 P50 ${c.bold(ms(report.stepStats?.p50))} / P95 ${c.bold(ms(report.stepStats?.p95))}` +
			`（${report.stepStats?.count ?? report.totalSteps ?? 0} 步样本）`,
	)

	const levels = sortedEntries(report.levelDistribution ?? {})
	if (levels.length) {
		lines.push(`级别分布 ${levels.map(([key, n]) => `${key} ${n}`).join(' · ')}`)
	}
	const codes = sortedEntries(report.failureCodes ?? {})
	if (codes.length) {
		const shown = codes.slice(0, maxCodes).map(([code, n]) => `${code} ${n}`)
		const rest = codes.length > maxCodes ? ` … +${codes.length - maxCodes}` : ''
		lines.push(`失败码 ${shown.join(' · ')}${rest}`)
	}

	if (okSites.length || missing.length || failed.length) {
		lines.push('')
		for (const site of report.sites) lines.push(siteLine(site, c))
	}

	// 一条都没跑起来时给一句可操作的话（M1 阶段这是最常见的状态）
	if (okSites.length === 0 && report.sites.length > 0) {
		lines.push('')
		lines.push(
			c.yellow(
				'还没有可跑的 flow：先 `rr record --url http://127.0.0.1:5173/basic --out flows/local-basic.json` 录一条，',
			),
		)
		lines.push(c.yellow('或把 flow 放到 flows/local-<route>.json（清单见 packages/harness/src/sites.ts）。'))
	}

	if (report.reportPath) {
		lines.push('')
		lines.push(`报告 ${c.dim(report.reportPath)}`)
	}
	if (report.outDir) lines.push(`HTML ${c.dim(`${report.outDir}/report.html`)}`)
	lines.push(c.dim(`复现 pnpm harness --runs ${report.runs} --sites local`))
	lines.push('')
	return lines
}
