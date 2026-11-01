/**
 * `@rr/harness` 的公开入口（契约见 docs/architecture.md §7）。
 *
 * 契约四件套一字不差：`SiteSpec` / `HarnessReport` / `runHarness` / `writeHtmlReport`。
 * 其余导出都是"可选扩展"（统计函数、站点清单、HTML 渲染、CLI 命令实现），
 * 按旧契约只 import 那四个符号的代码不受影响。
 */
export * from './types.js'

export type { LocalRoute, SiteMode } from './sites.js'
export {
	DEFAULT_SITE_HOST,
	DEFAULT_SITE_PORT,
	LOCAL_ROUTES,
	PUBLIC_SITES,
	isLocalSite,
	localSites,
	publicSites,
	routeToFlowPath,
	routeToSiteId,
	selectSites,
	siteOrigin,
} from './sites.js'

export {
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
} from './stats.js'

export { HARNESS_DIR_PREFIX, normalizeRunCount, runHarness } from './run.js'

export { escapeHtml, htmlReportPath, renderHtmlReport, writeHtmlReport } from './html.js'

export type { SummaryOptions } from './summary.js'
export { formatHarnessSummary } from './summary.js'

export { harnessFailed, harnessFailureReason, reportLooksNotImplemented } from './verdict.js'

export type { HarnessCommandOptions, HarnessCommandResult } from './command.js'
export { runHarnessCommand } from './command.js'

export { REPO_ROOT, displayPath, formatStamp, resolveFromRoot } from './paths.js'
