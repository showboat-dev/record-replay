import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { escapeHtml, renderHtmlReport, writeHtmlReport } from './index.js'
import type { HarnessReport } from './types.js'

const cleanupDirs: string[] = []

afterEach(async () => {
	while (cleanupDirs.length) {
		const dir = cleanupDirs.pop()
		if (dir) await rm(dir, { recursive: true, force: true })
	}
})

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'rr-harness-html-'))
	cleanupDirs.push(dir)
	return dir
}

function sampleReport(overrides: Partial<HarnessReport> = {}): HarnessReport {
	return {
		startedAt: '2026-11-01T07:32:10.000Z',
		finishedAt: '2026-11-01T07:32:24.000Z',
		runs: 2,
		sites: [
			{
				id: 'local-basic',
				url: 'http://127.0.0.1:5173/basic',
				flowPath: 'flows/local-basic.json',
				status: 'ok',
				runs: [
					{ ok: true, passCount: 5, failCount: 0, totalMs: 900 },
					{ ok: false, passCount: 3, failCount: 2, totalMs: 2100 },
				],
				successRate: 0.5,
				stepStats: { p50: 82, p95: 431, count: 10 },
				levelDistribution: { L1: 8, L2: 2 },
				failureCodes: { NO_EFFECT: 2 },
			},
			{
				id: 'local-dialog',
				flowPath: 'flows/local-dialog.json',
				status: 'missing',
				reason: 'flow 不存在：flows/local-dialog.json',
				runs: [],
				successRate: 0,
			},
		],
		stepStats: { p50: 82, p95: 431, count: 10 },
		levelDistribution: { L1: 8, L2: 2 },
		failureCodes: { NO_EFFECT: 2 },
		overallSuccessRate: 0.5,
		totalRuns: 2,
		passedRuns: 1,
		totalSteps: 10,
		skipped: [
			{
				id: 'local-dialog',
				flowPath: 'flows/local-dialog.json',
				status: 'missing',
				reason: 'flow 不存在：flows/local-dialog.json',
			},
		],
		...overrides,
	}
}

describe('escapeHtml', () => {
	it('转义五个危险字符', () => {
		expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
			'&lt;script&gt;alert(&quot;x&amp;y&#39;z&quot;)&lt;/script&gt;',
		)
	})

	it('数字/undefined/null 都不炸', () => {
		expect(escapeHtml(42)).toBe('42')
		expect(escapeHtml(0)).toBe('0')
		expect(escapeHtml(undefined)).toBe('')
		expect(escapeHtml(null)).toBe('')
	})

	it('对普通文本是幂等的（不会二次转义已经安全的内容）', () => {
		const plain = 'local-basic 100.0%'
		expect(escapeHtml(plain)).toBe(plain)
	})
})

describe('renderHtmlReport', () => {
	it('是完整的单文件 HTML：有 doctype/charset/内联 style', () => {
		const html = renderHtmlReport(sampleReport())
		expect(html.startsWith('<!doctype html>')).toBe(true)
		expect(html).toContain('<meta charset="utf-8">')
		expect(html).toContain('<style>')
		expect(html.trimEnd().endsWith('</html>')).toBe(true)
	})

	it('没有任何外部资源 / 脚本（离线可打开，CI artifact 直接能看）', () => {
		const html = renderHtmlReport(sampleReport())
		expect(html).not.toContain('<script')
		expect(html).not.toContain('<link')
		expect(html).not.toContain('@import')
		expect(html).not.toContain('<img')
		// 只允许 data: 以外的情况一律没有：这里断言不存在 src="http
		expect(html).not.toContain('src="http')
		expect(html).not.toContain('href="http')
	})

	it('展示站点 id、通过率、分位、级别与失败码', () => {
		const html = renderHtmlReport(sampleReport())
		expect(html).toContain('local-basic')
		expect(html).toContain('50.0%') // 站点通过率 & 整体通过率
		expect(html).toContain('82ms')
		expect(html).toContain('431ms')
		expect(html).toContain('NO_EFFECT')
		expect(html).toContain('L1')
		expect(html).toContain('L2')
		// 缺 flow 的站点也要出现（并给出原因）
		expect(html).toContain('local-dialog')
		expect(html).toContain('缺 flow')
	})

	it('恶意 id / reason 被转义，不会变成 HTML/事件处理器', () => {
		const hostile = sampleReport({
			sites: [
				{
					id: '<img src=x onerror=alert(1)>',
					flowPath: 'flows/"><script>alert(2)</script>.json',
					status: 'failed',
					reason: '</td><script>alert(3)</script>',
					runs: [],
					successRate: 0,
				},
			],
			skipped: [],
		})
		const html = renderHtmlReport(hostile)
		expect(html).not.toContain('<img')
		expect(html).not.toContain('<script>alert')
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
		expect(html).toContain('&lt;script&gt;alert(3)&lt;/script&gt;')
	})

	it('空报告也不炸，给出"没有选中任何站点"', () => {
		const html = renderHtmlReport(
			sampleReport({
				sites: [],
				skipped: [],
				levelDistribution: {},
				failureCodes: {},
				totalRuns: 0,
				passedRuns: 0,
				totalSteps: 0,
				overallSuccessRate: 0,
			}),
		)
		expect(html).toContain('没有选中任何站点')
		expect(html).toContain('没有失败步骤')
	})

	it('title 可定制，且同样转义', () => {
		const html = renderHtmlReport(sampleReport(), { title: '<b>回归</b>' })
		expect(html).toContain('&lt;b&gt;回归&lt;/b&gt;')
		expect(html).not.toContain('<b>回归</b>')
	})

	it('生成时间可注入，便于快照式断言', () => {
		const html = renderHtmlReport(sampleReport(), {
			generatedAt: new Date('2026-11-01T08:00:00.000Z'),
		})
		expect(html).toContain('2026-11-01T08:00:00.000Z')
	})
})

describe('writeHtmlReport', () => {
	it('写到不存在的目录会自动创建，内容是完整单文件', async () => {
		const dir = await tempDir()
		const outFile = join(dir, 'nested', 'report.html')
		await writeHtmlReport(sampleReport(), outFile)
		const html = await readFile(outFile, 'utf8')
		expect(html.startsWith('<!doctype html>')).toBe(true)
		expect(html).toContain('local-basic')
	})
})
