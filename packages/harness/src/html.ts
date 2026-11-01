/**
 * HTML 报告：**单文件**、内联 CSS、零外部资源（无 CDN / 无字体 / 无图片 / 无 JS）。
 *
 * 为什么手写拼接而不用模板引擎：仓库不允许新增依赖，且报告要能直接
 * `open artifacts/harness-xxx/report.html` 或作为 CI artifact 下载——单文件最省事。
 *
 * 安全：报告里的 id / url / reason 全部来自 flow 与错误信息，**必须 escapeHtml**。
 * 报告本身不含 `<script>`，所以不存在脚本注入；但未转义的 `<img onerror=...>` 仍然能
 * 在 HTML 里生效，因此所有动态文本一律走 `escapeHtml`。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { formatPercent, sortedEntries } from './stats.js'
import type { HarnessReport, HarnessSiteReport, SiteStatus } from './types.js'

/** HTML 文本转义（幂等用在所有动态字符串上） */
export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

const STYLE = `
:root {
	--bg: #f6f8fa; --card: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de;
	--ok: #1a7f37; --bad: #cf222e; --warn: #9a6700; --skip: #6e7781; --accent: #0969da;
	--trace: #8250df;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0d1117; --card: #161b22; --fg: #e6edf3; --muted: #8b949e; --line: #30363d;
		--ok: #3fb950; --bad: #f85149; --warn: #d29922; --skip: #8b949e; --accent: #58a6ff;
		--trace: #bc8cff;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0; padding: 32px 28px 48px; background: var(--bg); color: var(--fg);
	font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC",
		"Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: .2px; }
h2 { margin: 28px 0 10px; font-size: 15px; color: var(--muted); font-weight: 600; }
main { max-width: 1180px; margin: 0 auto; }
.meta { margin: 0; color: var(--muted); font-size: 12.5px; }
.meta code { color: var(--fg); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 12px; margin: 20px 0 4px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card .k { color: var(--muted); font-size: 12px; }
.card .v { font-size: 21px; font-weight: 650; margin-top: 2px; }
.card .v small { font-size: 12px; font-weight: 500; color: var(--muted); }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 12px; color: var(--muted); font-weight: 600; white-space: nowrap; background: color-mix(in srgb, var(--card) 82%, var(--bg)); }
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 状态列 / 通过 runs 列保持一行，表格在窄屏也读得下去 */
table.statuses td:nth-child(3), table.statuses th:nth-child(3),
table.statuses td:nth-child(4), table.statuses th:nth-child(4) { white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.url { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
.badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
.badge.failed { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
.badge.missing, .badge.skipped { color: var(--skip); border-color: color-mix(in srgb, var(--skip) 45%, transparent); }
.rate { display: flex; align-items: center; gap: 8px; min-width: 132px; }
.rate .bar { flex: 1; height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
.rate .bar i { display: block; height: 100%; border-radius: 999px; }
.rate .pct { font-variant-numeric: tabular-nums; font-size: 12.5px; min-width: 46px; text-align: right; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { font-size: 11.5px; padding: 1px 6px; border-radius: 6px; background: color-mix(in srgb, var(--bad) 12%, transparent); color: var(--bad); }
.chip.lvl { background: color-mix(in srgb, var(--trace) 12%, transparent); color: var(--trace); }
.chip.muted { background: color-mix(in srgb, var(--skip) 14%, transparent); color: var(--skip); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 780px) { .two { grid-template-columns: 1fr; } }
ul.plain { margin: 0; padding: 0; list-style: none; }
ul.plain li { padding: 7px 0; border-bottom: 1px solid var(--line); }
ul.plain li:last-child { border-bottom: 0; }
.note { color: var(--muted); font-size: 12px; margin: 10px 0 0; }
footer { max-width: 1180px; margin: 32px auto 0; color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); padding: 10px 2px; }
`

function formatMs(ms: number | undefined): string {
	if (ms === undefined || Number.isNaN(ms)) return '—'
	return `${Math.round(ms)}ms`
}

function statusLabel(status: SiteStatus | undefined): string {
	switch (status) {
		case 'ok':
			return '跑完'
		case 'missing':
			return '缺 flow'
		case 'skipped':
			return '跳过'
		case 'failed':
			return '无法运行'
		default:
			return '未知'
	}
}

function rateCell(site: HarnessSiteReport): string {
	if (site.status !== 'ok') return '<span class="empty">—</span>'
	const pct = Math.min(100, Math.max(0, site.successRate * 100))
	const color = site.successRate >= 1 ? 'var(--ok)' : site.successRate > 0 ? 'var(--warn)' : 'var(--bad)'
	return [
		'<div class="rate">',
		'<span class="bar"><i style="width:' + pct.toFixed(1) + '%;background:' + color + '"></i></span>',
		'<span class="pct">' + escapeHtml(formatPercent(site.successRate)) + '</span>',
		'</div>',
	].join('')
}

function failureCodeChips(codes: Record<string, number> | undefined): string {
	const entries = sortedEntries(codes ?? {})
	if (entries.length === 0) return '<span class="empty">—</span>'
	return (
		'<div class="chips">' +
		entries
			.map(
				([code, count]) =>
					`<span class="chip mono">${escapeHtml(code)} ×${escapeHtml(count)}</span>`,
			)
			.join('') +
		'</div>'
	)
}

function siteRow(site: HarnessSiteReport, index: number): string {
	const status = site.status ?? 'ok'
	const runsOk = site.runs.filter((run) => run.ok).length
	const runsCell =
		site.status === 'ok'
			? `${escapeHtml(runsOk)}/${escapeHtml(site.runs.length)}`
			: '<span class="empty">—</span>'
	const totalMs = site.runs.reduce((sum, run) => sum + run.totalMs, 0)
	const cells = [
		`<td class="num">${index + 1}</td>`,
		`<td><div class="mono">${escapeHtml(site.id)}</div>${site.url ? `<div class="url">${escapeHtml(site.url)}</div>` : ''}</td>`,
		`<td><span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span></td>`,
		`<td class="num">${runsCell}</td>`,
		`<td>${rateCell(site)}</td>`,
		`<td class="num">${escapeHtml(formatMs(site.stepStats?.p50))}</td>`,
		`<td class="num">${escapeHtml(formatMs(site.stepStats?.p95))}</td>`,
		`<td class="num">${site.status === 'ok' ? escapeHtml(formatMs(totalMs)) : '<span class="empty">—</span>'}</td>`,
		`<td>${failureCodeChips(site.failureCodes)}</td>`,
		`<td class="url">${escapeHtml(site.reason ?? '')}</td>`,
	]
	return `<tr>${cells.join('')}</tr>`
}

function levelSection(report: HarnessReport): string {
	const counts = report.levelDistribution ?? {}
	const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
	const order = ['L1', 'L2', 'L3', 'L4']
	const keys = [...order.filter((key) => key in counts), ...Object.keys(counts).filter((key) => !order.includes(key))]
	if (keys.length === 0) return '<p class="empty">还没有步骤命中级别数据（所有站点都缺 flow）。</p>'
	const rows = keys
		.map((key) => {
			const count = counts[key] ?? 0
			const pct = total === 0 ? 0 : (count / total) * 100
			const isDeep = key === 'L3' || key === 'L4'
			const color = isDeep ? 'var(--warn)' : 'var(--accent)'
			return `<tr>
	<td><span class="chip lvl mono">${escapeHtml(key)}</span></td>
	<td class="num">${escapeHtml(count)}</td>
	<td><div class="rate"><span class="bar"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></span><span class="pct">${escapeHtml(pct.toFixed(1))}%</span></div></td>
</tr>`
		})
		.join('')
	return `<table>
<thead><tr><th>级别</th><th class="num">次数</th><th>占比</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="note">L1 = 语义候选命中，L2 = stableHash 指纹，L3 = 视觉兜底，L4 = AI 兜底。L3/L4 占比上升说明语义定位在退化。</p>`
}

function failureSection(report: HarnessReport): string {
	const entries = sortedEntries(report.failureCodes ?? {})
	const total = entries.reduce((sum, [, n]) => sum + n, 0)
	if (entries.length === 0) return '<p class="empty">没有失败步骤 🎉</p>'
	const rows = entries
		.map(([code, count]) => {
			const pct = total === 0 ? 0 : (count / total) * 100
			return `<tr>
	<td><span class="chip mono">${escapeHtml(code)}</span></td>
	<td class="num">${escapeHtml(count)}</td>
	<td><div class="rate"><span class="bar"><i style="width:${pct.toFixed(1)}%;background:var(--bad)"></i></span><span class="pct">${escapeHtml(pct.toFixed(1))}%</span></div></td>
</tr>`
		})
		.join('')
	return `<table>
<thead><tr><th>失败码</th><th class="num">次数</th><th>占比</th></tr></thead>
<tbody>${rows}</tbody>
</table>`
}

function notRunSection(report: HarnessReport): string {
	const items = (report.skipped ?? []).slice()
	for (const site of report.sites) {
		if (site.status === 'failed') {
			items.push({
				id: site.id,
				flowPath: site.flowPath ?? '',
				status: 'failed',
				reason: site.reason ?? '未知错误',
			})
		}
	}
	if (items.length === 0) return '<p class="empty">全部站点都跑过了。</p>'
	return `<ul class="plain">${items
		.map(
			(item) =>
				`<li><span class="badge ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span> <span class="mono">${escapeHtml(item.id)}</span> <span class="url">${escapeHtml(item.flowPath)}</span><div class="url">${escapeHtml(item.reason)}</div></li>`,
		)
		.join('')}</ul>`
}

function card(key: string, value: string, hint = ''): string {
	const hintHtml = hint ? ` <small>${escapeHtml(hint)}</small>` : ''
	return `<div class="card"><div class="k">${escapeHtml(key)}</div><div class="v">${value}${hintHtml}</div></div>`
}

/** 渲染报告 HTML（纯函数，便于单测） */
export function renderHtmlReport(
	report: HarnessReport,
	opts: { title?: string; generatedAt?: Date } = {},
): string {
	const title = opts.title ?? 'rr harness 回归报告'
	const generatedAt = (opts.generatedAt ?? new Date()).toISOString()
	const okSites = report.sites.filter((site) => site.status === 'ok')
	const failedSites = report.sites.filter((site) => site.status === 'failed')
	const missingSites = report.sites.filter((site) => site.status === 'missing' || site.status === 'skipped')
	const steps = report.stepStats?.count ?? report.totalSteps ?? 0

	const cards = [
		card('站点', `${escapeHtml(okSites.length)}`, `跑完 / 共 ${report.sites.length} 个`),
		card('runs', `${escapeHtml(report.totalRuns ?? 0)}`, `每站 ${report.runs} 次`),
		card(
			'整体通过率',
			escapeHtml(formatPercent(report.overallSuccessRate ?? 0)),
			`${report.passedRuns ?? 0}/${report.totalRuns ?? 0} runs`,
		),
		card('步骤 P50', escapeHtml(formatMs(report.stepStats?.p50)), `${steps} 步样本`),
		card('步骤 P95', escapeHtml(formatMs(report.stepStats?.p95)), `${steps} 步样本`),
		card(
			'缺 flow / 无法运行',
			`${escapeHtml(missingSites.length + failedSites.length)}`,
			`缺 ${missingSites.length} · 失败 ${failedSites.length}`,
		),
	].join('')

	const rows = report.sites.map((site, index) => siteRow(site, index)).join('')

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(report.startedAt)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
	<h1>${escapeHtml(title)}</h1>
	<p class="meta">
		开始 <code>${escapeHtml(report.startedAt)}</code>
		· 结束 <code>${escapeHtml(report.finishedAt ?? '未完成')}</code>
		· 每站 <code>${escapeHtml(report.runs)}</code> 次
		· 报告 <code>${escapeHtml(report.reportPath ?? 'report.json')}</code>
	</p>
</header>

<section class="cards">${cards}</section>

<h2>逐站结果</h2>
${
	report.sites.length === 0
		? '<p class="empty">这次没有选中任何站点。</p>'
		: `<table class="statuses">
<thead><tr>
	<th class="num">#</th><th>站点</th><th>状态</th><th class="num">通过 runs</th><th>通过率</th>
	<th class="num">步骤 P50</th><th class="num">步骤 P95</th><th class="num">总耗时</th>
	<th>失败码</th><th>说明</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`
}

<section class="two">
	<div>
		<h2>命中级别分布</h2>
		${levelSection(report)}
	</div>
	<div>
		<h2>失败码分布</h2>
		${failureSection(report)}
	</div>
</section>

<h2>未运行的站点</h2>
${notRunSection(report)}

<p class="note">复现：<code class="mono">pnpm harness --runs ${escapeHtml(report.runs)} --sites local</code>（报告为单文件，含内联 CSS，无外部资源）</p>
</main>
<footer>rr harness · 生成于 ${escapeHtml(generatedAt)} · 分位口径：R-7 线性插值，ms 四舍五入</footer>
</body>
</html>
`
}

/** 写单文件 HTML 报告（目录不存在会自动创建） */
export async function writeHtmlReport(report: HarnessReport, outFile: string): Promise<void> {
	const html = renderHtmlReport(report)
	await mkdir(dirname(outFile), { recursive: true })
	await writeFile(outFile, html, 'utf8')
}

/** HTML 报告默认路径：与 `report.json` 同目录（`<outDir>/report.html`） */
export function htmlReportPath(report: HarnessReport): string {
	if (!report.outDir) return 'report.html'
	return join(report.outDir, 'report.html')
}
