/**
 * 占位实现：M1 由 harness 负责人替换。接口契约见 docs/architecture.md §7。
 */
import type { RepairClient } from '@rr/ai'

export interface SiteSpec {
	id: string
	flowPath: string
	url?: string
	local?: boolean
}

export interface HarnessReport {
	startedAt: string
	runs: number
	sites: Array<{
		id: string
		runs: Array<{ ok: boolean; passCount: number; failCount: number; totalMs: number }>
		successRate: number
	}>
	stepStats: { p50: number; p95: number }
	levelDistribution: Record<string, number>
	failureCodes: Record<string, number>
}

export async function runHarness(_opts: {
	sites: SiteSpec[]
	runs: number
	artifactsRoot?: string
	ai?: RepairClient | null
}): Promise<HarnessReport> {
	throw new Error('@rr/harness 尚未实现（M1）')
}

export async function writeHtmlReport(_report: HarnessReport, _outFile: string): Promise<void> {
	throw new Error('@rr/harness 尚未实现（M1）')
}
