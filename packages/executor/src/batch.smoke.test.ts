/**
 * 批量执行真实浏览器冒烟（默认跳过，`RR_SMOKE=1` 才跑）。
 *
 * 自带最小站点：
 * - `GET /form`：一个输入框 + 一个"保存"按钮，把值写进 `#saved` 并设 localStorage（用于验证行隔离）；
 * - `GET /iso`：页面加载时把 localStorage 里的值渲染到 `#state`（空则显示 empty），用于证明"每行新 context"。
 *
 * 覆盖：3 行成功 + 每行变量生效 + 行级 artifacts 落盘；1 行缺变量只算该行失败、整批继续；
 *      stopOnFailure 中断返回已跑完的行；行隔离（上一行的 localStorage 不会串到下一行）。
 */
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makeId, parseFlow, type ElementRef, type Flow } from '@rr/schema'
import { computeStableHash } from '@rr/resolver'

import { playBatch } from './index.js'

const ENABLED = process.env.RR_SMOKE === '1'

const PAGES: Record<string, string> = {
	'/form': `<!doctype html><html><head><meta charset="utf-8"><title>批量表单</title></head><body>
<h1>批量表单</h1>
<input id="name" data-testid="name-input" />
<button type="button" id="save" data-testid="save-btn"
  onclick="const v=document.getElementById('name').value;localStorage.setItem('lastName',v);document.getElementById('saved').textContent='已保存：'+v">
  保存
</button>
<div id="saved" role="status" data-testid="saved"></div>
</body></html>`,
	'/iso': `<!doctype html><html><head><meta charset="utf-8"><title>隔离检查</title></head><body>
<h1>隔离检查</h1>
<div id="state" role="status" data-testid="state"></div>
<script>document.getElementById('state').textContent = localStorage.getItem('lastName') ? 'dirty:' + localStorage.getItem('lastName') : 'clean'</script>
</body></html>`,
}

let server: Server | undefined
let site = ''
let workDir = ''

async function startSite(): Promise<{ server: Server; site: string }> {
	const httpServer = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const html = PAGES[url.pathname]
		if (!html) {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
			res.end('not found')
			return
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(html)
	})
	await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
	const address = httpServer.address()
	const port = typeof address === 'object' && address ? address.port : 0
	return { server: httpServer, site: `http://127.0.0.1:${port}` }
}

function ref(testid: string, tag = 'div'): ElementRef {
	return {
		observed: {
			tag,
			attributes: { 'data-testid': testid },
			rect: { x: 10, y: 20, width: 200, height: 40 },
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: [{ kind: 'testid', value: testid, score: 1, source: 'record' }],
		fingerprint: {
			tag,
			attrs: { 'data-testid': testid },
			stableHash: computeStableHash({ tag, attrs: { 'data-testid': testid } }),
		},
		frame: { path: [] },
	}
}

/** 用 {{name}} 填输入框 → 点保存 → 断言保存结果 */
function formFlow(startUrl = `${site}/form`): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: makeId('batch-form'),
		title: '批量表单',
		version: 1,
		createdAt: new Date().toISOString(),
		meta: {
			env: { startUrl, viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: 'smoke', version: '0.0.1' },
		},
		variables: [
			{ name: 'name', type: 'string', secret: false, source: 'csv', defaultValue: '默认值' },
			{ name: 'email', type: 'string', secret: false, source: 'csv', defaultValue: '' },
		],
		steps: [
			{ id: 'nav', kind: 'navigate', url: startUrl },
			{ id: 'fill', kind: 'input', target: ref('name-input', 'input'), value: '{{name}}', clear: true },
			{
				id: 'save',
				kind: 'click',
				target: ref('save-btn', 'button'),
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
			{
				id: 'assert-saved',
				kind: 'assert',
				target: ref('saved'),
				assertion: { kind: 'text', contains: '已保存' },
			},
		],
		selfHealed: [],
	})
}

/**
 * 每行都会填 email → 缺 email 的行会 VARIABLE_MISSING。
 * 注意：email 变量**故意不给 defaultValue**（否则缺列会被默认值兜住，永远不报缺变量）。
 */
function emailFlow(): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: makeId('batch-email'),
		title: '批量表单（必填 email）',
		version: 1,
		createdAt: new Date().toISOString(),
		meta: {
			env: { startUrl: `${site}/form`, viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: 'smoke', version: '0.0.1' },
		},
		variables: [
			{ name: 'name', type: 'string', secret: false, source: 'csv', defaultValue: '默认值' },
			{ name: 'email', type: 'string', secret: false, source: 'csv' },
		],
		steps: [
			{ id: 'nav', kind: 'navigate', url: `${site}/form` },
			{ id: 'fill-name', kind: 'input', target: ref('name-input', 'input'), value: '{{name}}', clear: true },
			{ id: 'fill-email', kind: 'input', target: ref('name-input', 'input'), value: '{{email}}', clear: true },
			{ id: 'save', kind: 'click', target: ref('save-btn', 'button'), button: 'left', clickCount: 1, modifiers: [] },
			{ id: 'assert-saved', kind: 'assert', target: ref('saved'), assertion: { kind: 'text', contains: '已保存' } },
		],
		selfHealed: [],
	})
}

/** 隔离检查：点保存写 localStorage → 下一页看 state */
function isolationFlow(): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: makeId('batch-iso'),
		title: '行隔离检查',
		version: 1,
		createdAt: new Date().toISOString(),
		meta: {
			env: { startUrl: `${site}/form`, viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: 'smoke', version: '0.0.1' },
		},
		variables: [],
		steps: [
			// 先看状态（新 context 应为 clean），再写脏数据：
			// 如果每行没有新建 context，第 2 行这里就会看到上一行留下的 dirty 而失败
			{ id: 'nav-iso', kind: 'navigate', url: `${site}/iso` },
			{
				id: 'assert-clean',
				kind: 'assert',
				target: ref('state'),
				assertion: { kind: 'text', equals: 'clean' },
			},
			{ id: 'nav-form', kind: 'navigate', url: `${site}/form` },
			{ id: 'fill', kind: 'input', target: ref('name-input', 'input'), value: 'dirty', clear: true },
			{
				id: 'save',
				kind: 'click',
				target: ref('save-btn', 'button'),
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
			{
				id: 'assert-saved',
				kind: 'assert',
				target: ref('saved'),
				assertion: { kind: 'text', contains: '已保存' },
			},
			{ id: 'nav-iso-2', kind: 'navigate', url: `${site}/iso` },
			{
				id: 'assert-dirty',
				kind: 'assert',
				target: ref('state'),
				assertion: { kind: 'text', contains: 'dirty' },
			},
		],
		selfHealed: [],
	})
}

beforeAll(async () => {
	if (!ENABLED) return
	const started = await startSite()
	server = started.server
	site = started.site
	workDir = await mkdtemp(join(tmpdir(), 'rr-batch-smoke-'))
}, 30_000)

afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
	if (workDir) await rm(workDir, { recursive: true, force: true })
})

describe.skipIf(!ENABLED)('冒烟: playBatch 批量执行', () => {
	it('3 行全部成功：变量逐行生效、行级 artifacts 落盘、结果顺序与输入一致', async () => {
		const progress: number[] = []
		const result = await playBatch({
			flow: formFlow(),
			rows: [
				{ index: 1, values: { name: '张三', email: 'a@x.com' } },
				{ index: 2, values: { name: '李四', email: 'b@x.com' } },
				{ index: 3, values: { name: '王五', email: 'c@x.com' } },
			],
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
			onRow: (r) => progress.push(r.index),
		})
		if (result.failCount > 0) throw new Error(`批量失败：${JSON.stringify(result.rows, null, 2)}`)
		expect(result.total).toBe(3)
		expect(result.okCount).toBe(3)
		expect(result.failCount).toBe(0)
		expect(result.stopped).toBe(false)
		expect(result.rows.map((r) => r.index)).toEqual([1, 2, 3])
		expect(progress).toEqual([1, 2, 3])
		expect(result.batchId).toBeTruthy()

		// 行级 artifacts：<flowId>/batches/<batchId>/row-<index>/result.json
		const rowDir = join(result.artifactsDir ?? '', 'row-2')
		expect(existsSync(join(rowDir, 'result.json'))).toBe(true)
		expect(existsSync(join(rowDir, 'log.txt'))).toBe(true)
		const detail = JSON.parse(await readFile(join(rowDir, 'result.json'), 'utf8')) as {
			index: number
			ok: boolean
			rowValues: Record<string, string>
		}
		expect(detail).toMatchObject({ index: 2, ok: true })
		expect(detail.rowValues.name).toBe('李四')
	}, 180_000)

	it('某行缺变量：只有该行失败（VARIABLE_MISSING），其余行照常通过', async () => {
		const result = await playBatch({
			flow: emailFlow(),
			rows: [
				{ index: 1, values: { name: '张三', email: 'a@x.com' } },
				// 这一行没有 email → renderStep 抛 VARIABLE_MISSING
				{ index: 2, values: { name: '李四' } },
				{ index: 3, values: { name: '王五', email: 'c@x.com' } },
			],
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
		})
		expect(result).toMatchObject({ total: 3, okCount: 2, failCount: 1, stopped: false })
		const bad = result.rows.find((r) => r.index === 2)
		expect(bad?.ok).toBe(false)
		expect(bad?.failedStep?.code).toBe('VARIABLE_MISSING')
		expect(bad?.failedStep?.reason).toContain('email')
		// 失败行有截图（相对 artifacts 的 posix 路径），且文件真实存在
		expect(bad?.screenshot).toMatch(/^.*batches\/.*\/row-2\/\d+\/after\.png$/)
		expect(existsSync(join(workDir, 'artifacts', bad?.screenshot ?? ''))).toBe(true)
	}, 180_000)

	it('stopOnFailure：第 2 行失败后立刻停，返回已跑完的 2 行', async () => {
		const result = await playBatch({
			flow: emailFlow(),
			rows: [
				{ index: 1, values: { name: '张三', email: 'a@x.com' } },
				{ index: 2, values: { name: '李四' } },
				{ index: 3, values: { name: '王五', email: 'c@x.com' } },
			],
			stopOnFailure: true,
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
		})
		expect(result.stopped).toBe(true)
		expect(result.rows).toHaveLength(2)
		expect(result.rows.map((r) => r.index)).toEqual([1, 2])
		expect(result).toMatchObject({ total: 3, okCount: 1, failCount: 1 })
	}, 180_000)

	it('行隔离：每行新 context，上一行的 localStorage 不会串到下一行', async () => {
		const result = await playBatch({
			flow: isolationFlow(),
			rows: [
				{ index: 1, values: {} },
				{ index: 2, values: {} },
			],
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
		})
		if (result.failCount > 0) throw new Error(`行隔离失败：${JSON.stringify(result.rows, null, 2)}`)
		expect(result.okCount).toBe(2)
	}, 180_000)

	it('空行数组：直接返回全 0（不启动浏览器）', async () => {
		const result = await playBatch({
			flow: formFlow(),
			rows: [],
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
		})
		expect(result).toMatchObject({ total: 0, okCount: 0, failCount: 0, stopped: false, rows: [] })
	}, 30_000)
})
