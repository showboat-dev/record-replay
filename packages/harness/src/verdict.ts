/**
 * 回归"判官"：把报告翻译成 CI 能用的结论（退出码 / 失败原因）。
 *
 * 单独一个文件是因为两个方向的消费者完全不同：
 * - CLI 要 `exitCode`；
 * - HTML/摘要要"人话原因"。
 * 放在一起容易让 runHarness 变得又跑又判，测试也不好写。
 */
import type { HarnessReport } from './types.js'

/**
 * 这一轮回归算不算失败：
 * - 任何一个真的跑了 flow 的站点通过率 < 100%；
 * - 或者任何一个站点是 `failed`（flow 读不出来 / executor 抛错）。
 *
 * 纯粹的 `missing` / `skipped`（还没录 flow）**不算失败**：M1 阶段 11 条 flow 必然是
 * 边录边补的，把"还没录"当失败会让 `pnpm harness` 永远是红的，反而没人看。
 */
export function harnessFailed(report: HarnessReport): boolean {
	return report.sites.some(
		(site) => site.status === 'failed' || (site.status === 'ok' && site.successRate < 1),
	)
}

/** 失败原因摘要（一行人话，给 CLI 用） */
export function harnessFailureReason(report: HarnessReport): string {
	const failedSites = report.sites.filter((site) => site.status === 'failed')
	const regressed = report.sites.filter((site) => site.status === 'ok' && site.successRate < 1)
	const parts: string[] = []
	if (regressed.length) {
		const names = regressed.map((site) => `${site.id} ${((site.successRate * 100).toFixed(1))}%`)
		parts.push(`${regressed.length} 个站点未全绿（${names.join('、')}）`)
	}
	if (failedSites.length) {
		const names = failedSites.map((site) => `${site.id}: ${site.reason ?? '未知错误'}`)
		parts.push(`${failedSites.length} 个站点无法运行（${names.join('；')}）`)
	}
	if (parts.length === 0) return ''
	return parts.join('；')
}

/**
 * 失败是否**全部**来自"executor 还没实现"（M1 并行开发期的常见状态）。
 * 是的话 CLI 给一句更友好的提示，而不是甩一堆报错。
 */
export function reportLooksNotImplemented(report: HarnessReport): boolean {
	const failed = report.sites.filter((site) => site.status === 'failed')
	if (failed.length === 0) return false
	return failed.every((site) => (site.reason ?? '').includes('尚未实现'))
}
