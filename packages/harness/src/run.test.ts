import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
	formatStamp,
	harnessFailed,
	harnessFailureReason,
	normalizeRunCount,
	reportLooksNotImplemented,
	runHarness,
} from './index.js'
import type {
	HarnessDeps,
	HarnessPlayOptions,
	HarnessProgress,
	RunResultLike,
	SiteSpec,
	StepResultLike,
} from './types.js'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const cleanupDirs: string[] = []

afterEach(async () => {
	while (cleanupDirs.length) {
		const dir = cleanupDirs.pop()
		if (dir) await rm(dir, { recursive: true, force: true })
	}
})

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'rr-harness-run-'))
	cleanupDirs.push(dir)
	return dir
}

function localSite(id: string, route = id.replace(/^local-/, '')): SiteSpec {
	return {
		id,
		flowPath: `flows/${id}.json`,
		url: `http://127.0.0.1:5173/${route}`,
		local: true,
		public: false,
	}
}

function publicSite(id: string): SiteSpec {
	return {
		id,
		flowPath: `flows/${id}.json`,
		url: 'https://example.com/',
		local: false,
		public: true,
	}
}

function step(overrides: Partial<StepResultLike> = {}): StepResultLike {
	return { status: 'pass', ms: 10, level: 'L1', ...overrides }
}

function runResult(ok: boolean, steps: StepResultLike[], totalMs: number, runId: string): RunResultLike {
	return {
		flowId: 'flow_1',
		runId,
		ok,
		steps,
		metrics: {
			totalMs,
			passCount: steps.filter((s) => s.status === 'pass').length,
			failCount: steps.filter((s) => s.status === 'fail').length,
		},
	}
}

interface MockOptions {
	/** flowPath 后缀 → 该站的 playRuns 行为 */
	flows: Record<string, () => Promise<RunResultLike[]>>
	/** 额外视为"存在"的 flow（用于测 loadFlow 抛错）；默认等于 Object.keys(flows) */
	existing?: string[]
	/** now() 的返回序列，最后一个会一直重复 */
	clocks?: Date[]
}

interface MockDeps extends Partial<HarnessDeps> {
	/** 每次 playRuns 收到的参数，用于断言透传 */
	calls: HarnessPlayOptions[]
}

const DEFAULT_CLOCKS = [
	new Date('2026-11-01T07:32:10.000Z'),
	new Date('2026-11-01T07:32:24.000Z'),
]

function mockDeps(options: MockOptions): MockDeps {
	const calls: HarnessPlayOptions[] = []
	const { flows } = options
	const existing = options.existing ?? Object.keys(flows)
	const clocks = options.clocks ?? DEFAULT_CLOCKS
	let tick = 0
	const pathOf = (flow: unknown): string => String((flow as { flowPath?: string }).flowPath ?? '')
	return {
		calls,
		exists: (absPath) => existing.some((key) => absPath.endsWith(key)),
		loadFlow: async (absPath) => ({ flowPath: absPath }),
		playRuns: async (opts) => {
			calls.push(opts)
			const key = Object.keys(flows).find((candidate) => pathOf(opts.flow).endsWith(candidate))
			if (!key) throw new Error(`mock 没有为 ${pathOf(opts.flow)} 配置 playRuns`)
			const handler = flows[key]
			if (!handler) throw new Error(`mock 缺少 handler: ${key}`)
			return await handler()
		},
		now: () => {
			const index = Math.min(tick, clocks.length - 1)
			tick += 1
			return clocks[index] ?? new Date(DEFAULT_CLOCKS[0]?.getTime() ?? 0)
		},
	}
}

// ---------------------------------------------------------------------------
// runHarness：主路径
// ---------------------------------------------------------------------------

describe('runHarness —— 正常一轮', () => {
	it('逐站跑 playRuns，汇总成功率/分位/级别/失败码，并落 report.json', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({
			flows: {
				'flows/local-basic.json': async () => [
					runResult(
						true,
						[step({ ms: 10 }), step({ ms: 20 }), step({ level: 'L2', ms: 30 })],
						60,
						'r1',
					),
					runResult(
						false,
						[
							step({ ms: 40 }),
							step({ status: 'fail', level: 'L2', ms: 50, error: { code: 'NO_EFFECT' } }),
							step({ status: 'skip', ms: 0 }),
						],
						90,
						'r2',
					),
				],
				'flows/local-spa.json': async () => [
					runResult(true, [step({ level: 'L3', ms: 100 })], 100, 'r3'),
				],
			},
		})

		const report = await runHarness({
			sites: [localSite('local-basic'), localSite('local-spa', 'spa')],
			runs: 2,
			artifactsRoot,
			deps,
		})

		// 站点级
		expect(report.runs).toBe(2)
		expect(report.sites.map((site) => site.id)).toEqual(['local-basic', 'local-spa'])
		const [basic, spa] = report.sites
		expect(basic?.status).toBe('ok')
		expect(basic?.runs).toHaveLength(2)
		expect(basic?.successRate).toBe(0.5)
		expect(basic?.stepStats).toEqual({ p50: 30, p95: 48, count: 5 })
		expect(basic?.levelDistribution).toEqual({ L1: 3, L2: 2 })
		expect(basic?.failureCodes).toEqual({ NO_EFFECT: 1 })
		expect(basic?.url).toBe('http://127.0.0.1:5173/basic')
		expect(spa?.successRate).toBe(1)

		// 全局级：3 个 run、2 个通过
		expect(report.totalRuns).toBe(3)
		expect(report.passedRuns).toBe(2)
		expect(report.overallSuccessRate).toBe(0.6667)
		// 非 skip 步骤 6 个：[10,20,30,40,50,100] → p50 = 35, p95 = 87.5 → 88
		expect(report.stepStats).toEqual({ p50: 35, p95: 88, count: 6 })
		// 全部步骤 7 个（含 1 个 skip）
		expect(report.totalSteps).toBe(7)
		expect(report.levelDistribution).toEqual({ L1: 3, L2: 2, L3: 1 })
		expect(report.failureCodes).toEqual({ NO_EFFECT: 1 })
		expect(report.skipped).toEqual([])

		// 时间戳来自注入的 now
		expect(report.startedAt).toBe('2026-11-01T07:32:10.000Z')
		expect(report.finishedAt).toBe('2026-11-01T07:32:24.000Z')

		// 报告落盘：<artifactsRoot>/harness-<stamp>/report.json
		const outDir = report.outDir
		const reportPath = report.reportPath
		expect(outDir).toBe(join(artifactsRoot, 'harness-20261101-153210'))
		expect(reportPath).toBe(join(outDir ?? '', 'report.json'))
		if (!reportPath) throw new Error('reportPath 缺失')
		const text = await readFile(reportPath, 'utf8')
		expect(JSON.parse(text)).toEqual(report)
	})

	it('透传 runs / artifactsRoot / headless / ai 给 playRuns', async () => {
		const artifactsRoot = await tempDir()
		const ai = { locate: async () => null }
		const deps = mockDeps({
			flows: { 'flows/local-basic.json': async () => [runResult(true, [step()], 10, 'r1')] },
		})
		await runHarness({
			sites: [localSite('local-basic')],
			runs: 3,
			artifactsRoot,
			ai,
			deps,
		})
		expect(deps.calls).toHaveLength(1)
		const call = deps.calls[0]
		expect(call?.runs).toBe(3)
		expect(call?.headless).toBe(true)
		expect(call?.artifactsRoot).toBe(artifactsRoot)
		expect(call?.ai).toBe(ai)
	})

	it('没传 ai 时显式传 null（executor 据此走纯本地路径）', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({
			flows: { 'flows/local-basic.json': async () => [runResult(true, [step()], 10, 'r1')] },
		})
		await runHarness({ sites: [localSite('local-basic')], runs: 1, artifactsRoot, deps })
		expect(deps.calls[0]?.ai).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// runHarness：缺 flow / 公开站不联网
// ---------------------------------------------------------------------------

describe('runHarness —— 缺 flow', () => {
	it('本地站缺 flow → missing；公开站缺 flow → skipped；不调用 playRuns', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({ flows: {} })
		const report = await runHarness({
			sites: [localSite('local-basic'), publicSite('public-example')],
			runs: 1,
			artifactsRoot,
			deps,
		})

		expect(report.sites.map((site) => site.status)).toEqual(['missing', 'skipped'])
		expect(report.sites[0]?.reason).toContain('flow 不存在')
		expect(report.skipped).toHaveLength(2)
		expect(report.skipped?.map((item) => item.status)).toEqual(['missing', 'skipped'])
		// 关键：公开站/缺 flow 的站绝不触发 playRuns（= 不联网、不起浏览器）
		expect(deps.calls).toHaveLength(0)
		expect(report.totalRuns).toBe(0)
		expect(report.overallSuccessRate).toBe(0)
		// "还没录 flow" 不算回归失败，否则 M1 阶段 pnpm harness 永远是红的
		expect(harnessFailed(report)).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// runHarness：站点级失败隔离
// ---------------------------------------------------------------------------

describe('runHarness —— 站点级失败不影响其它站', () => {
	it('单站抛错 → status failed，其它站照跑', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({
			flows: {
				'flows/local-basic.json': async () => {
					throw new Error('executor 尚未实现（M1）')
				},
				'flows/local-spa.json': async () => [runResult(true, [step()], 10, 'r1')],
			},
		})
		const report = await runHarness({
			sites: [localSite('local-basic'), localSite('local-spa', 'spa')],
			runs: 1,
			artifactsRoot,
			deps,
		})
		expect(report.sites[0]?.status).toBe('failed')
		expect(report.sites[0]?.reason).toContain('尚未实现')
		expect(report.sites[1]?.status).toBe('ok')
		expect(report.sites[1]?.successRate).toBe(1)
		// 整体统计只算真正跑过的站
		expect(report.totalRuns).toBe(1)
		expect(harnessFailed(report)).toBe(true)
		expect(harnessFailureReason(report)).toContain('local-basic')
		expect(reportLooksNotImplemented(report)).toBe(true)
	})

	it('失败原因不是"尚未实现"时 reportLooksNotImplemented 为 false', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({
			flows: {
				'flows/local-basic.json': async () => {
					throw new Error('浏览器崩了')
				},
			},
		})
		const report = await runHarness({
			sites: [localSite('local-basic')],
			runs: 1,
			artifactsRoot,
			deps,
		})
		expect(reportLooksNotImplemented(report)).toBe(false)
	})

	it('playRuns 返回空数组也算失败（不给"假绿"）', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({ flows: { 'flows/local-basic.json': async () => [] } })
		const report = await runHarness({
			sites: [localSite('local-basic')],
			runs: 1,
			artifactsRoot,
			deps,
		})
		expect(report.sites[0]?.status).toBe('failed')
		expect(report.sites[0]?.reason).toContain('没有返回任何结果')
	})

	it('flow 读不出来（loadFlow 抛错）→ failed 且带原因', async () => {
		const artifactsRoot = await tempDir()
		const deps: Partial<HarnessDeps> = {
			exists: () => true,
			loadFlow: async () => {
				throw new Error('flow 校验失败（flows/local-basic.json）')
			},
			playRuns: async () => [],
		}
		const report = await runHarness({
			sites: [localSite('local-basic')],
			runs: 1,
			artifactsRoot,
			deps,
		})
		expect(report.sites[0]?.status).toBe('failed')
		expect(report.sites[0]?.reason).toContain('flow 校验失败')
	})
})

// ---------------------------------------------------------------------------
// 进度回调 / 参数校验 / 小工具
// ---------------------------------------------------------------------------

describe('runHarness —— onProgress', () => {
	it('依次给出 site:start / site:done / site:skip / report', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({
			flows: { 'flows/local-basic.json': async () => [runResult(true, [step()], 10, 'r1')] },
		})
		const events: string[] = []
		await runHarness({
			sites: [localSite('local-basic'), localSite('local-dialog')],
			runs: 1,
			artifactsRoot,
			deps,
			onProgress: (event: HarnessProgress) => {
				const siteId = 'site' in event ? event.site.id : ''
				events.push(`${event.type}:${siteId}`)
			},
		})
		expect(events).toEqual([
			'site:start:local-basic',
			'site:done:local-basic',
			'site:skip:local-dialog',
			'report:',
		])
	})

	it('onProgress 抛错不影响回归结果', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({
			flows: { 'flows/local-basic.json': async () => [runResult(true, [step()], 10, 'r1')] },
		})
		const report = await runHarness({
			sites: [localSite('local-basic')],
			runs: 1,
			artifactsRoot,
			deps,
			onProgress: () => {
				throw new Error('UI 挂了')
			},
		})
		expect(report.sites[0]?.status).toBe('ok')
	})
})

describe('normalizeRunCount', () => {
	it('接受正整数与数字字符串', () => {
		expect(normalizeRunCount(1)).toBe(1)
		expect(normalizeRunCount(10)).toBe(10)
		expect(normalizeRunCount('3')).toBe(3)
	})

	it('拒绝 0 / 负数 / 小数 / NaN / boolean', () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, true, 'abc', undefined]) {
			expect(() => normalizeRunCount(bad)).toThrow(/runs 必须是 >= 1 的整数/)
		}
	})
})

describe('formatStamp', () => {
	it('本地时间 YYYYMMDD-HHmmss（文件名安全、可排序）', () => {
		expect(formatStamp(new Date(2026, 10, 1, 15, 32, 10))).toBe('20261101-153210')
		expect(formatStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405')
	})
})

describe('harnessFailed / harnessFailureReason', () => {
	it('缺 flow 不算失败，通过率 < 100% 才算', async () => {
		const artifactsRoot = await tempDir()
		const deps = mockDeps({
			flows: {
				'flows/local-basic.json': async () => [
					runResult(true, [step()], 10, 'r1'),
					runResult(false, [step({ status: 'fail', error: { code: 'NO_EFFECT' } })], 20, 'r2'),
				],
			},
		})
		const report = await runHarness({
			sites: [localSite('local-basic'), localSite('local-dialog')],
			runs: 2,
			artifactsRoot,
			deps,
		})
		expect(harnessFailed(report)).toBe(true)
		expect(harnessFailureReason(report)).toContain('local-basic')
		expect(harnessFailureReason(report)).toContain('50.0%')
		expect(harnessFailureReason(report)).not.toContain('local-dialog')
	})
})
