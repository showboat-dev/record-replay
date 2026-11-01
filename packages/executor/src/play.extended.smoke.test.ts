/**
 * 真实 Chromium 冒烟（扩展能力）：多标签页 / 原生对话框 / 下载 / 组合键 / 上传变量。
 *
 * 默认跳过（和 play.smoke.test.ts 一样），`RR_SMOKE=1 pnpm test` 或
 * `RR_SMOKE=1 npx vitest run packages/executor/src/play.extended.smoke.test.ts` 才跑。
 *
 * 页面来源：
 * - /dialog、/upload-download、/basic 用 fixtures 站真实页面（并行已就绪）；
 * - 多标签页场景用本文件内置的两张最小页（/tabs-a → window.open('/tabs-b')），
 *   因为 fixture 站的多标签页页面还在并行开发中，而"跨系统复制粘贴"是本次的核心业务场景。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makeId, parseFlow, type ElementRef, type Flow, type Step } from '@rr/schema'
import { computeStableHash } from '@rr/resolver'

import { playFlow } from './index.js'

const ENABLED = process.env.RR_SMOKE === '1'
const SITE_ROOT = fileURLToPath(new URL('../../../fixtures/site/public', import.meta.url))

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
}

/** 多标签页场景（A 系统复制 → B 系统粘贴） */
const EXTRA_PAGES: Record<string, string> = {
	'/tabs-a': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>A 系统</title>
<link rel="stylesheet" href="/site.css"></head><body data-rr-scenario="tabs-a">
<h1>A 系统</h1>
<textarea id="copy-source" data-testid="copy-source" rows="2">订单号-{{ORDER}}</textarea>
<button type="button" id="open-b" data-testid="open-b"
  onclick="window.open('/tabs-b','_blank')">打开 B 系统</button>
<div id="a-status" role="status" data-testid="a-status"></div>
<script>window.__rr={source:function(){return document.getElementById('copy-source').value}}</script>
</body></html>`,
	'/tabs-b': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>B 系统</title>
<link rel="stylesheet" href="/site.css"></head><body data-rr-scenario="tabs-b">
<h1>B 系统</h1>
<textarea id="b-target" data-testid="b-target" rows="2" placeholder="在这里粘贴订单号"></textarea>
<div id="b-status" role="status" data-testid="b-status"></div>
<script>
const target = document.getElementById('b-target')
target.addEventListener('input', function () {
  document.getElementById('b-status').textContent = 'B 系统已收到: ' + target.value
})
</script>
</body></html>`,
}

let server: Server | undefined
let site = ''
let artifactsRoot = ''
let uploadRoot = ''

async function startSite(): Promise<{ server: Server; site: string }> {
	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const pathname = url.pathname === '/' ? '/basic' : url.pathname
		const extra = EXTRA_PAGES[pathname]
		if (extra) {
			res.writeHead(200, { 'content-type': MIME['.html'] as string })
			res.end(extra)
			return
		}
		const candidates = extname(pathname) === '' ? [`${pathname}.html`, pathname] : [pathname]
		for (const candidate of candidates) {
			const file = join(SITE_ROOT, candidate)
			try {
				const info = await stat(file)
				if (!info.isFile()) continue
				const body = await readFile(file)
				res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
				res.end(body)
				return
			} catch {
				/* 试下一个 */
			}
		}
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
		res.end('not found')
	})
	await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
	const address = httpServer.address()
	const port = typeof address === 'object' && address ? address.port : 0
	return { server: httpServer, site: `http://127.0.0.1:${port}` }
}

/* ---------------- IR 构造 ---------------- */

interface RefSpec {
	tag: string
	attrs: Record<string, string>
	text?: string
	candidates: ElementRef['candidates']
	fingerprint: { role?: string; accessibleName?: string; attrs: Record<string, string> }
}

function makeRef(spec: RefSpec): ElementRef {
	const attrs = spec.fingerprint.attrs
	return {
		observed: {
			tag: spec.tag,
			attributes: spec.attrs,
			...(spec.text ? { text: spec.text } : {}),
			rect: { x: 10, y: 20, width: 160, height: 40 },
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: spec.candidates,
		fingerprint: {
			tag: spec.tag,
			...(spec.fingerprint.role ? { role: spec.fingerprint.role } : {}),
			...(spec.fingerprint.accessibleName
				? { accessibleName: spec.fingerprint.accessibleName }
				: {}),
			attrs,
			stableHash: computeStableHash({
				tag: spec.tag,
				...(spec.fingerprint.role ? { role: spec.fingerprint.role } : {}),
				...(spec.fingerprint.accessibleName
					? { accessibleName: spec.fingerprint.accessibleName }
					: {}),
				attrs,
			}),
		},
		frame: { path: [] },
	}
}

const byTestId = (testid: string, tag = 'div', role?: string): ElementRef =>
	makeRef({
		tag,
		attrs: { 'data-testid': testid },
		candidates: [{ kind: 'testid', value: testid, score: 1, source: 'record' }],
		fingerprint: { ...(role ? { role } : {}), attrs: { 'data-testid': testid } },
	})

function buildFlow(steps: Step[], variables: Flow['variables'] = [], startUrl = `${site}/basic`): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: makeId('ext'),
		title: 'executor 扩展冒烟',
		version: 1,
		createdAt: new Date().toISOString(),
		meta: {
			env: { startUrl, viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: 'smoke', version: '0.0.1' },
		},
		variables,
		steps,
		selfHealed: [],
	})
}

beforeAll(async () => {
	if (!ENABLED) return
	const started = await startSite()
	server = started.server
	site = started.site
	artifactsRoot = await mkdtemp(join(tmpdir(), 'rr-ext-smoke-'))
	uploadRoot = await mkdtemp(join(tmpdir(), 'rr-upload-'))
	await writeFile(join(uploadRoot, '订单附件.txt'), 'hello from rr', 'utf8')
}, 30_000)

afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
	if (artifactsRoot) await rm(artifactsRoot, { recursive: true, force: true })
	if (uploadRoot) await rm(uploadRoot, { recursive: true, force: true })
})

describe.skipIf(!ENABLED)('扩展冒烟: 多标签页 / 对话框 / 下载 / 组合键 / 上传变量', () => {
	it('多标签页：A 系统输入 → 点开 B 系统 → 切标签页粘贴 → 切回 A 校验', async () => {
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/tabs-a` },
			{
				id: 'input-a',
				kind: 'input',
				target: byTestId('copy-source', 'textarea', 'textbox'),
				value: '订单号-{{order}}',
				clear: true,
			},
			// 点这个按钮会 window.open 新标签页；没有 expect → 会走 NO_EFFECT 探测，
			// 新标签页必须被识别成"有副作用"（否则这里会误报 NO_EFFECT）
			{
				id: 'open-b',
				kind: 'click',
				target: byTestId('open-b', 'button', 'button'),
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
			// switchTab 表达：切到第 1 个新标签页（可能异步出现，executor 会等）
			{ id: 'switch-b', kind: 'switchTab', index: 1 },
			{
				id: 'input-b',
				kind: 'input',
				target: byTestId('b-target', 'textarea', 'textbox'),
				value: '订单号-{{order}}',
				clear: true,
			},
			{
				id: 'assert-b',
				kind: 'assert',
				target: byTestId('b-status', 'div', 'status'),
				assertion: { kind: 'text', contains: 'B 系统已收到: 订单号-8888' },
			},
			// page:{index} 表达：显式回到标签页 0 校验 A 的内容还在
			{
				id: 'assert-a',
				kind: 'assert',
				page: { index: 0 },
				target: byTestId('copy-source', 'textarea', 'textbox'),
				assertion: { kind: 'value', equals: '订单号-8888' },
			},
		], [
			{
				name: 'order',
				type: 'string',
				secret: false,
				source: 'input',
				defaultValue: '8888',
			},
		])

		const result = await playFlow({ flow, artifactsRoot, headless: true, timeoutMs: 8_000 })
		if (!result.ok) throw new Error(`多标签页回放失败：${JSON.stringify(result.steps, null, 2)}`)
		expect(result.steps.map((s) => s.status)).toEqual([
			'pass',
			'pass',
			'pass',
			'pass',
			'pass',
			'pass',
			'pass',
		])
		const json = JSON.parse(
			await readFile(join(result.artifactsDir ?? '', 'result.json'), 'utf8'),
		) as { pages?: number; stepsDetail: Array<{ pageIndex?: number }> }
		expect(json.pages).toBeGreaterThanOrEqual(2)
		expect(json.stepsDetail[3]?.pageIndex).toBe(1) // switchTab 后在标签页 1
		expect(json.stepsDetail[6]?.pageIndex).toBe(0) // page:{index:0} 切回起点页
	}, 120_000)

	it('原生对话框：confirm 接受 / prompt 填文本 / alert 关闭（对话框由上一步动作触发）', async () => {
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/dialog` },
			{
				id: 'click-confirm',
				kind: 'click',
				target: byTestId('open-confirm', 'button', 'button'),
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
			{ id: 'accept-confirm', kind: 'dialog', action: 'accept' },
			{
				id: 'assert-confirm',
				kind: 'assert',
				target: byTestId('dialog-result', 'div', 'status'),
				assertion: { kind: 'text', contains: 'confirm 返回: true' },
			},
			{
				id: 'click-prompt',
				kind: 'click',
				target: byTestId('open-prompt', 'button', 'button'),
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
			{ id: 'accept-prompt', kind: 'dialog', action: 'accept', promptText: '{{who}}' },
			{
				id: 'assert-prompt',
				kind: 'assert',
				target: byTestId('dialog-result', 'div', 'status'),
				assertion: { kind: 'text', contains: 'prompt 返回: 张三' },
			},
			{
				id: 'click-alert',
				kind: 'click',
				target: byTestId('open-alert', 'button', 'button'),
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
			{ id: 'dismiss-alert', kind: 'dialog', action: 'dismiss' },
		], [{ name: 'who', type: 'string', secret: false, source: 'input', defaultValue: '张三' }])

		const result = await playFlow({ flow, artifactsRoot, headless: true, timeoutMs: 8_000 })
		if (!result.ok) throw new Error(`对话框回放失败：${JSON.stringify(result.steps, null, 2)}`)
		const json = JSON.parse(
			await readFile(join(result.artifactsDir ?? '', 'result.json'), 'utf8'),
		) as { dialogs: string[] }
		expect(json.dialogs.length).toBe(3)
		expect(json.dialogs[0]).toContain('confirm')
		expect(json.dialogs[1]).toContain('prompt')
	}, 120_000)

	it('dialog 步骤等不到对话框 → DIALOG_UNEXPECTED（不是裸 timeout）', async () => {
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/dialog` },
			{ id: 'expect-none', kind: 'dialog', action: 'accept' },
		])
		const result = await playFlow({
			flow,
			artifactsRoot,
			headless: true,
			timeoutMs: 800,
			screenshotMode: 'off',
		})
		expect(result.ok).toBe(false)
		expect(result.steps[1]?.error?.code).toBe('DIALOG_UNEXPECTED')
		expect(result.steps[1]?.error?.message).toContain('没有出现')
	}, 120_000)

	it('下载：click 触发下载 + expect.download，文件落到 downloads/（同名自动加序号）', async () => {
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/upload-download` },
			{
				id: 'download-1',
				kind: 'click',
				target: byTestId('trigger-download', 'button', 'button'),
				button: 'left',
				clickCount: 1,
				modifiers: [],
				expect: { kind: 'download', filenamePattern: 'report' },
			},
			{
				id: 'download-2',
				kind: 'click',
				target: byTestId('trigger-download', 'button', 'button'),
				button: 'left',
				clickCount: 1,
				modifiers: [],
				expect: { kind: 'download', filenamePattern: 'report' },
			},
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true, timeoutMs: 8_000 })
		if (!result.ok) throw new Error(`下载回放失败：${JSON.stringify(result.steps, null, 2)}`)

		const downloadsDir = join(result.artifactsDir ?? '', 'downloads')
		const files = (await readdir(downloadsDir)).sort()
		expect(files).toEqual(['report-1.csv', 'report.csv'])
		const content = await readFile(join(downloadsDir, 'report.csv'), 'utf8')
		expect(content).toContain('# download #1')

		const json = JSON.parse(
			await readFile(join(result.artifactsDir ?? '', 'result.json'), 'utf8'),
		) as { downloads?: string[] }
		expect(json.downloads).toEqual(['report.csv', 'report-1.csv'])
	}, 120_000)

	it('组合键：全选 + Backspace 清空（locator 与 page 两种入口）', async () => {
		// macOS 上 Control+A 是「移动到行首」（emacs 绑定），全选是 Meta+A（Cmd+A）；
		// 录制端在 mac 上记到的也是 Meta，所以这里按平台取修饰键（回放只是忠实重放 chord）。
		const selectAll: Array<'Control' | 'Meta'> = [process.platform === 'darwin' ? 'Meta' : 'Control']
		const selectAllLabel = process.platform === 'darwin' ? 'Cmd+A' : 'Ctrl+A'
		expect(selectAllLabel.length).toBeGreaterThan(0)
		const target = makeRef({
			tag: 'input',
			attrs: { id: 'full-name', 'data-testid': 'field-full-name' },
			candidates: [{ kind: 'testid', value: 'field-full-name', score: 1, source: 'record' }],
			fingerprint: { role: 'textbox', accessibleName: '姓名', attrs: { id: 'full-name' } },
		})
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/basic` },
			{ id: 'fill', kind: 'input', target, value: 'hello-world', clear: true },
			// locator.press('Control+a')
			{ id: 'select-all', kind: 'key', target, key: 'a', modifiers: selectAll },
			{ id: 'delete-all', kind: 'key', target, key: 'Backspace' },
			{ id: 'assert-empty', kind: 'assert', target, assertion: { kind: 'value', equals: '' } },
			// 再填一次，用 page.keyboard.press('Control+a')（无 target）
			{ id: 'fill-again', kind: 'input', target, value: 'second-round', clear: true },
			{
				id: 'select-all-page',
				kind: 'key',
				key: 'a',
				modifiers: selectAll,
				page: { index: 0 },
			},
			{ id: 'delete-page', kind: 'key', key: 'Backspace' },
			{ id: 'assert-empty-2', kind: 'assert', target, assertion: { kind: 'value', equals: '' } },
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true, timeoutMs: 8_000 })
		if (!result.ok) throw new Error(`组合键回放失败：${JSON.stringify(result.steps, null, 2)}`)
		expect(result.metrics.failCount).toBe(0)
	}, 120_000)

	it('上传：files 用 {{file}} 模板注入绝对路径，页面显示真实文件名', async () => {
		const filePath = join(uploadRoot, '订单附件.txt')
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/upload-download` },
			{
				id: 'upload',
				kind: 'upload',
				target: makeRef({
					tag: 'input',
					attrs: { id: 'upload-input', 'data-testid': 'upload-input' },
					candidates: [{ kind: 'testid', value: 'upload-input', score: 1, source: 'record' }],
					fingerprint: { attrs: { id: 'upload-input' } },
				}),
				files: ['{{file}}'],
			},
			{
				id: 'assert-name',
				kind: 'assert',
				target: byTestId('upload-filename', 'p'),
				assertion: { kind: 'text', contains: '订单附件.txt' },
			},
		], [{ name: 'file', type: 'file', secret: false, source: 'input', defaultValue: filePath }])

		const result = await playFlow({ flow, artifactsRoot, headless: true, timeoutMs: 8_000 })
		if (!result.ok) throw new Error(`上传回放失败：${JSON.stringify(result.steps, null, 2)}`)
	}, 120_000)

	it('上传变量缺失 → VARIABLE_MISSING；文件不存在 → NOT_ACTIONABLE（带真实路径）', async () => {
		const inputRef = makeRef({
			tag: 'input',
			attrs: { id: 'upload-input', 'data-testid': 'upload-input' },
			candidates: [{ kind: 'testid', value: 'upload-input', score: 1, source: 'record' }],
			fingerprint: { attrs: { id: 'upload-input' } },
		})

		const missingVar = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/upload-download` },
			{ id: 'upload', kind: 'upload', target: inputRef, files: ['{{no_such_file}}'] },
		])
		const missingResult = await playFlow({
			flow: missingVar,
			artifactsRoot,
			headless: true,
			screenshotMode: 'off',
		})
		expect(missingResult.steps[1]?.error?.code).toBe('VARIABLE_MISSING')
		expect(missingResult.steps[1]?.error?.message).toContain('no_such_file')

		const missingFile = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/upload-download` },
			{ id: 'upload', kind: 'upload', target: inputRef, files: ['/tmp/definitely-not-here.png'] },
		])
		const missingFileResult = await playFlow({
			flow: missingFile,
			artifactsRoot,
			headless: true,
			screenshotMode: 'off',
		})
		expect(missingFileResult.steps[1]?.error?.code).toBe('NOT_ACTIONABLE')
		expect(missingFileResult.steps[1]?.error?.message).toContain('/tmp/definitely-not-here.png')
	}, 120_000)
})
