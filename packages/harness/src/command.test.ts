import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runHarnessCommand } from './index.js'
import type { HarnessDeps, RunResultLike, StepResultLike } from './types.js'

const cleanupDirs: string[] = []

afterEach(async () => {
	while (cleanupDirs.length) {
		const dir = cleanupDirs.pop()
		if (dir) await rm(dir, { recursive: true, force: true })
	}
})

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'rr-harness-cmd-'))
	cleanupDirs.push(dir)
	return dir
}

function step(overrides: Partial<StepResultLike> = {}): StepResultLike {
	return { status: 'pass', ms: 10, level: 'L1', ...overrides }
}

function runResult(ok: boolean, steps: StepResultLike[], totalMs: number): RunResultLike {
	return {
		flowId: 'flow_1',
		runId: 'run_1',
		ok,
		steps,
		metrics: {
			totalMs,
			passCount: steps.filter((s) => s.status === 'pass').length,
			failCount: steps.filter((s) => s.status === 'fail').length,
		},
	}
}

/** 只有 /basic 有 flow 的最小 deps（其余站点会走 missing 分支） */
function deps(handler: () => Promise<RunResultLike[]>): Partial<HarnessDeps> {
	return {
		exists: (absPath) => absPath.endsWith('flows/local-basic.json'),
		loadFlow: async (absPath) => ({ flowPath: absPath }),
		playRuns: async () => await handler(),
		now: () => new Date('2026-11-01T07:32:10.000Z'),
	}
}

const basicSite = {
	id: 'local-basic',
	flowPath: 'flows/local-basic.json',
	local: true,
}

describe('runHarnessCommand', () => {
	it('全绿 → exitCode 0，同时产出 report.json 和 report.html', async () => {
		const artifactsRoot = await tempDir()
		const printed: string[] = []
		const result = await runHarnessCommand({
			sites: [basicSite],
			runs: 2,
			artifactsRoot,
			deps: deps(async () => [runResult(true, [step()], 10)]),
			print: (line) => printed.push(line),
		})

		expect(result.exitCode).toBe(0)
		expect(result.reportPath).toBeDefined()
		expect(result.htmlPath).toBeDefined()
		if (!result.reportPath || !result.htmlPath) throw new Error('路径缺失')

		// report.json 与返回的 report 一致
		expect(JSON.parse(await readFile(result.reportPath, 'utf8'))).toEqual(result.report)
		// report.html 是同目录的单文件报告
		const html = await readFile(result.htmlPath, 'utf8')
		expect(html.startsWith('<!doctype html>')).toBe(true)
		expect(html).toContain('local-basic')

		// 打印了摘要（且首行含 harness 标记）
		expect(printed.length).toBeGreaterThan(3)
		expect(printed.join('\n')).toContain('local-basic')
		expect(result.summary.length).toBeGreaterThan(3)
	})

	it('有站点未全绿 → exitCode 1，摘要末尾说明原因', async () => {
		const artifactsRoot = await tempDir()
		const result = await runHarnessCommand({
			sites: [basicSite],
			runs: 1,
			artifactsRoot,
			deps: deps(async () => [
				runResult(false, [step({ status: 'fail', error: { code: 'NO_EFFECT' } })], 10),
			]),
			print: () => {},
		})
		expect(result.exitCode).toBe(1)
		expect(result.summary.join('\n')).toContain('回归未通过')
		expect(result.summary.join('\n')).toContain('NO_EFFECT')
	})

	it('站点无法运行（executor 抛错）也是 exitCode 1', async () => {
		const artifactsRoot = await tempDir()
		const result = await runHarnessCommand({
			sites: [basicSite],
			runs: 1,
			artifactsRoot,
			deps: deps(async () => {
				throw new Error('浏览器崩了')
			}),
			print: () => {},
		})
		expect(result.exitCode).toBe(1)
		expect(result.report.sites[0]?.status).toBe('failed')
	})

	it('quiet=true 时完全不打印，但仍返回摘要', async () => {
		const artifactsRoot = await tempDir()
		const printed: string[] = []
		const result = await runHarnessCommand({
			sites: [basicSite],
			runs: 1,
			artifactsRoot,
			deps: deps(async () => [runResult(true, [step()], 10)]),
			quiet: true,
			print: (line) => printed.push(line),
		})
		expect(printed).toEqual([])
		expect(result.summary.length).toBeGreaterThan(0)
	})

	it('html=false 时不写 report.html（报告只出 JSON）', async () => {
		const artifactsRoot = await tempDir()
		const result = await runHarnessCommand({
			sites: [basicSite],
			runs: 1,
			artifactsRoot,
			html: false,
			deps: deps(async () => [runResult(true, [step()], 10)]),
			print: () => {},
		})
		expect(result.htmlPath).toBeUndefined()
		if (!result.reportPath) throw new Error('reportPath 缺失')
		await expect(readFile(result.reportPath, 'utf8')).resolves.toContain('"startedAt"')
	})

	it('sites 传模式字符串时会走 selectSites（local = 11 条本地站）', async () => {
		const artifactsRoot = await tempDir()
		const result = await runHarnessCommand({
			sites: 'local',
			runs: 1,
			artifactsRoot,
			// 所有 flow 都不存在 → 全部 missing，但不算失败
			deps: {
				exists: () => false,
				loadFlow: async () => ({}),
				playRuns: async () => [],
				now: () => new Date('2026-11-01T07:32:10.000Z'),
			},
			print: () => {},
		})
		expect(result.report.sites).toHaveLength(11)
		expect(result.report.sites.every((site) => site.status === 'missing')).toBe(true)
		expect(result.exitCode).toBe(0)
	})
})
