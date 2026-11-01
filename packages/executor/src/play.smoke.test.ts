/**
 * 真实 Chromium 冒烟（默认跳过，`RR_SMOKE=1 pnpm test` 才跑）。
 *
 * 为什么默认跳过：`pnpm test` 必须快、且不依赖浏览器缓存；这个文件是**真实回放**验证，
 * 由 CI/本地显式开启。它自带一个零依赖静态服务器（serve fixtures/site/public），
 * 不依赖 fixture 站是否已启动，也不需要 recorder 先产出 flow（flow 在这里手写，结构按 IR 契约）。
 *
 * 覆盖：L1 语义命中 / L2 指纹兜底 / closed shadow host+position / expect+assert /
 *      失败 artifact / NO_EFFECT / 歧义拒绝 / 变量缺失 / baseUrl 重定基。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makeId, parseFlow, type ElementRef, type Flow, type Step } from '@rr/schema'
import { computeStableHash } from '@rr/resolver'

import { playFlow, playRuns } from './index.js'

const ENABLED = process.env.RR_SMOKE === '1'
const RUNS = Number.parseInt(process.env.RR_SMOKE_RUNS ?? '3', 10)
const SITE_ROOT = fileURLToPath(new URL('../../../fixtures/site/public', import.meta.url))

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
}

/** 额外测试页（不落在 fixture 目录里，属于本测试私有） */
const EXTRA_PAGES: Record<string, string> = {
	// 故意用**不可聚焦**的 div：可聚焦按钮点击会产生 focus ring（像素变化但无产品副作用），
	// NO_EFFECT 判定会把它当作 UI 反馈放过 —— 那是刻意的（避免误杀所有按钮点击）。
	'/noop':
		'<!doctype html><html><body>' +
		'<div id="noop" style="width:160px;height:60px;background:#eee">无副作用区块</div>' +
		'</body></html>',
	'/ambiguous':
		'<!doctype html><html><body>' +
		'<button id="a" style="position:absolute;left:10px;top:100px;width:100px;height:30px">提交</button>' +
		'<button id="b" style="position:absolute;left:10px;top:140px;width:100px;height:30px">提交</button>' +
		'</body></html>',
}

let server: Server | undefined
let site = ''
let artifactsRoot = ''

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

		// 无扩展名的路由（/basic、/shadow-closed …）映射到同名 .html
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
				/* 继续试下一个候选 */
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

/**
 * 用 CDP pierce 算出「closed shadow 内层按钮中心」相对 host padding box 的偏移。
 * 这正是 recorder 录制侧要做的事（spike A.4），这里在测试里现场算，避免硬编码几何。
 */
async function computeClosedShadowOffset(target: string): Promise<{ x: number; y: number }> {
	const browser = await chromium.launch({ headless: true })
	try {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
		const page = await context.newPage()
		await page.goto(target, { waitUntil: 'load' })
		const cdp = await context.newCDPSession(page)
		await cdp.send('DOM.enable')
		const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as unknown as {
			root: Record<string, unknown>
		}

		interface AnyNode {
			backendNodeId?: number
			attributes?: string[]
			children?: AnyNode[]
			shadowRoots?: AnyNode[]
		}
		function find(
			node: AnyNode,
			matcher: (attrs: Record<string, string>) => boolean,
		): AnyNode | undefined {
			const attrs: Record<string, string> = {}
			const flat = node.attributes ?? []
			for (let i = 0; i < flat.length; i += 2) attrs[flat[i] as string] = flat[i + 1] as string
			if (matcher(attrs)) return node
			for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
				const found = find(child, matcher)
				if (found) return found
			}
			return undefined
		}

		const host = find(doc.root as AnyNode, (attrs) => attrs['id'] === 'closed-card')
		const inner = find(doc.root as AnyNode, (attrs) => attrs['id'] === 'cc-submit')
		if (!host?.backendNodeId || !inner?.backendNodeId) throw new Error('CDP 未找到 host/inner')

		const hostBox = (await cdp.send('DOM.getBoxModel', { backendNodeId: host.backendNodeId })) as {
			model: { padding: number[] }
		}
		const innerBox = (await cdp.send('DOM.getBoxModel', { backendNodeId: inner.backendNodeId })) as {
			model: { content: number[] }
		}
		// quad = [x1,y1, x2,y1, x2,y2, x1,y2]；host padding quad 的 [0],[1] 即 padding box 原点
		const pad = hostBox.model.padding
		const box = innerBox.model.content
		const innerCenterX = ((box[0] as number) + (box[2] as number)) / 2
		const innerCenterY = ((box[1] as number) + (box[5] as number)) / 2
		return {
			x: Math.round(innerCenterX - (pad[0] as number)),
			y: Math.round(innerCenterY - (pad[1] as number)),
		}
	} finally {
		await browser.close()
	}
}

/* ---------------- flow 构造（模拟 recorder 产出：候选升序 + 指纹） ---------------- */

interface RefSpec {
	tag: string
	attrs: Record<string, string>
	text?: string
	rect?: { x: number; y: number; width: number; height: number }
	candidates: ElementRef['candidates']
	fingerprint: { role?: string; accessibleName?: string; attrs: Record<string, string> }
}

function makeRef(spec: RefSpec): ElementRef {
	const rect = spec.rect ?? { x: 10, y: 20, width: 120, height: 32 }
	const fingerprintAttrs = spec.fingerprint.attrs
	const fingerprint = {
		tag: spec.tag,
		...(spec.fingerprint.role ? { role: spec.fingerprint.role } : {}),
		...(spec.fingerprint.accessibleName
			? { accessibleName: spec.fingerprint.accessibleName }
			: {}),
		attrs: fingerprintAttrs,
		stableHash: computeStableHash({
			tag: spec.tag,
			...(spec.fingerprint.role ? { role: spec.fingerprint.role } : {}),
			...(spec.fingerprint.accessibleName
				? { accessibleName: spec.fingerprint.accessibleName }
				: {}),
			attrs: fingerprintAttrs,
		}),
		frame: { path: [] },
	}
	return {
		observed: {
			tag: spec.tag,
			attributes: spec.attrs,
			...(spec.text ? { text: spec.text } : {}),
			rect,
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: spec.candidates,
		fingerprint,
		frame: { path: [] },
	}
}

const refName = (): ElementRef =>
	makeRef({
		tag: 'input',
		attrs: { id: 'full-name', name: 'fullName', type: 'text' },
		candidates: [
			{ kind: 'testid', value: 'field-full-name', score: 1, source: 'record' },
			{ kind: 'label', value: '姓名', score: 20, source: 'record' },
			{ kind: 'css', value: '#full-name', score: 40, source: 'record' },
		],
		fingerprint: {
			role: 'textbox',
			accessibleName: '姓名',
			attrs: { id: 'full-name', name: 'fullName', type: 'text' },
		},
	})

const refEmail = (): ElementRef =>
	makeRef({
		tag: 'input',
		attrs: { id: 'email', name: 'email', type: 'email' },
		candidates: [
			{ kind: 'testid', value: 'field-email', score: 1, source: 'record' },
			{ kind: 'label', value: '邮箱', score: 20, source: 'record' },
		],
		fingerprint: {
			role: 'textbox',
			accessibleName: '邮箱',
			attrs: { id: 'email', name: 'email', type: 'email' },
		},
	})

const refSubmit = (): ElementRef =>
	makeRef({
		tag: 'button',
		attrs: { id: 'submit-basic', type: 'submit' },
		text: '提交表单',
		candidates: [
			{ kind: 'testid', value: 'submit-basic', score: 1, source: 'record' },
			{ kind: 'role', value: { role: 'button', name: '提交表单' }, score: 20, source: 'record' },
		],
		fingerprint: {
			role: 'button',
			accessibleName: '提交表单',
			attrs: { id: 'submit-basic', type: 'submit' },
		},
	})

const refResult = (): ElementRef =>
	makeRef({
		tag: 'div',
		attrs: { id: 'basic-result', role: 'status' },
		candidates: [
			{ kind: 'testid', value: 'basic-result', score: 1, source: 'record' },
			{ kind: 'css', value: '#basic-result', score: 30, source: 'record' },
		],
		fingerprint: { role: 'status', attrs: { id: 'basic-result', role: 'status' } },
	})

function buildFlow(steps: Step[], variables: Flow['variables'] = []): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: makeId('smoke'),
		title: 'smoke: /basic 表单',
		version: 1,
		createdAt: new Date().toISOString(),
		meta: {
			env: { startUrl: `${site}/basic`, viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: 'smoke', version: '0.0.1' },
		},
		variables,
		steps,
		selfHealed: [],
	})
}

function basicFlow(): Flow {
	return buildFlow(
		[
			{ id: 'nav', kind: 'navigate', url: `${site}/basic` },
			{ id: 'fill-name', kind: 'input', target: refName(), value: '张三', clear: true },
			{ id: 'fill-email', kind: 'input', target: refEmail(), value: '{{email}}', clear: true },
			{
				id: 'click-submit',
				kind: 'click',
				target: refSubmit(),
				button: 'left',
				clickCount: 1,
				modifiers: [],
				expect: { kind: 'elementVisible', target: refResult() },
			},
			{
				id: 'assert-result',
				kind: 'assert',
				target: refResult(),
				assertion: { kind: 'text', contains: '提交成功' },
			},
		],
		[
			{
				name: 'email',
				type: 'string',
				secret: false,
				source: 'input',
				defaultValue: 'zhangsan@example.com',
			},
		],
	)
}

beforeAll(async () => {
	if (!ENABLED) return
	const started = await startSite()
	server = started.server
	site = started.site
	artifactsRoot = await mkdtemp(join(tmpdir(), 'rr-smoke-'))
}, 30_000)

afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
	if (artifactsRoot) await rm(artifactsRoot, { recursive: true, force: true })
})

describe.skipIf(!ENABLED)('冒烟: 真实 Chromium 回放', () => {
	it('L1 语义命中：/basic 5 步全通过（含 expect + assert）', async () => {
		const result = await playFlow({ flow: basicFlow(), artifactsRoot, headless: true })
		expect(result.ok).toBe(true)
		expect(result.metrics.failCount).toBe(0)
		expect(result.steps.map((s) => s.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass'])
		expect(result.steps.every((s) => s.level === 'L1' || s.level === undefined)).toBe(true)
		expect(result.metrics.passCount).toBe(5)
	}, 60_000)

	it('L2 指纹兜底：语义候选全挂掉，靠 stableHash 仍然填对', async () => {
		const brokenName = refName()
		brokenName.candidates = [
			{ kind: 'testid', value: 'nope-not-here', score: 1, source: 'record' },
			{ kind: 'css', value: '#nope-not-here', score: 2, source: 'record' },
		]
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/basic` },
			{ id: 'fill-name', kind: 'input', target: brokenName, value: '李四', clear: true },
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true })
		expect(result.ok).toBe(true)
		const step = result.steps[1]
		expect(step?.level).toBe('L2')
		if (step?.status !== 'pass') throw new Error(`L2 步骤失败：${JSON.stringify(step?.error)}`)
	}, 60_000)

	it('失败必落 artifact：元素不存在 → ELEMENT_NOT_FOUND + before/after/snapshot/log', async () => {
		const missing = makeRef({
			tag: 'button',
			attrs: { id: 'ghost' },
			text: '不存在的按钮',
			candidates: [
				{ kind: 'testid', value: 'ghost', score: 1, source: 'record' },
				{ kind: 'text', value: '不存在的按钮', score: 2, source: 'record' },
			],
			fingerprint: { role: 'button', accessibleName: '不存在的按钮', attrs: { id: 'ghost' } },
		})
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/basic` },
			{
				id: 'click-ghost',
				kind: 'click',
				target: missing,
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true })
		expect(result.ok).toBe(false)
		expect(result.steps[1]?.error?.code).toBe('ELEMENT_NOT_FOUND')

		const stepDir = join(result.artifactsDir ?? '', '1')
		for (const name of ['before.png', 'after.png', 'snapshot.json', 'log.txt']) {
			const info = await stat(join(stepDir, name))
			expect(info.isFile()).toBe(true)
		}
		const logText = await readFile(join(stepDir, 'log.txt'), 'utf8')
		expect(logText).toContain('ELEMENT_NOT_FOUND')
		const resultJson = JSON.parse(
			await readFile(join(result.artifactsDir ?? '', 'result.json'), 'utf8'),
		) as { ok: boolean; steps: unknown[] }
		expect(resultJson.ok).toBe(false)
		expect(resultJson.steps).toHaveLength(2)
	}, 60_000)

	it('NO_EFFECT：点到没有副作用的区块要报 NO_EFFECT（不是静默通过）', async () => {
		const noop = makeRef({
			tag: 'div',
			attrs: { id: 'noop' },
			text: '无副作用区块',
			candidates: [{ kind: 'css', value: '#noop', score: 1, source: 'record' }],
			fingerprint: { attrs: { id: 'noop' } },
		})
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/noop` },
			{ id: 'click-noop', kind: 'click', target: noop, button: 'left', clickCount: 1, modifiers: [] },
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true })
		expect(result.ok).toBe(false)
		expect(result.steps[1]?.error?.code).toBe('NO_EFFECT')
	}, 60_000)

	it('歧义：两个几何分差 <15% 的同名按钮 → 拒绝猜测，报 ELEMENT_NOT_FOUND', async () => {
		const ambiguous = makeRef({
			tag: 'button',
			attrs: {},
			text: '提交',
			// 故意把观测矩形放在两个按钮正中间 → 两个候选几何分相同
			rect: { x: 10, y: 120, width: 100, height: 30 },
			candidates: [{ kind: 'text', value: '提交', score: 1, source: 'record' }],
			fingerprint: { role: 'button', accessibleName: '提交', attrs: {} },
		})
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/ambiguous` },
			{
				id: 'click-ambiguous',
				kind: 'click',
				target: ambiguous,
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true })
		expect(result.ok).toBe(false)
		expect(result.steps[1]?.error?.code).toBe('ELEMENT_NOT_FOUND')
		expect(result.steps[1]?.error?.message).toContain('AMBIGUOUS')
	}, 60_000)

	it('变量缺失 → VARIABLE_MISSING（明确原因，不是填空串）', async () => {
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/basic` },
			{ id: 'fill-name', kind: 'input', target: refName(), value: '{{no_such_var}}', clear: true },
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true })
		expect(result.ok).toBe(false)
		expect(result.steps[1]?.error?.code).toBe('VARIABLE_MISSING')
		expect(result.steps[1]?.error?.message).toContain('no_such_var')
	}, 60_000)

	it('closed shadow：host + position 点中内层按钮（spike A 降级方案）', async () => {
		const offset = await computeClosedShadowOffset(`${site}/shadow-closed`)
		const host = makeRef({
			tag: 'x-closed-card',
			attrs: { id: 'closed-card', 'data-testid': 'closed-card' },
			rect: { x: 100, y: 200, width: 900, height: 300 },
			candidates: [
				{ kind: 'testid', value: 'closed-card', score: 1, source: 'record' },
				{ kind: 'css', value: '#closed-card', score: 20, source: 'record' },
			],
			fingerprint: { attrs: { id: 'closed-card' } },
		})
		// recorder 会把这些字段写在 observed 上（schema 已支持）
		host.observed.shadowRootType = 'closed'
		host.observed.innerOffset = offset

		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/shadow-closed` },
			{
				id: 'click-inner',
				kind: 'click',
				target: host,
				button: 'left',
				clickCount: 1,
				modifiers: [],
				// 契约要求 closed shadow 的 click 必须带 position（host padding-box 相对 CSS px）
				position: offset,
			},
			{
				id: 'assert-result',
				kind: 'assert',
				target: makeRef({
					tag: 'div',
					attrs: { id: 'closed-result', role: 'status' },
					candidates: [{ kind: 'testid', value: 'closed-result', score: 1, source: 'record' }],
					fingerprint: { role: 'status', attrs: { id: 'closed-result' } },
				}),
				assertion: { kind: 'text', contains: 'closed shadow 内部按钮被点击' },
			},
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true })
		if (!result.ok) throw new Error(`closed shadow 回放失败：${JSON.stringify(result.steps)}`)
		expect(result.steps[1]?.level).toBe('L1')
	}, 90_000)

	it('closed shadow 目标绝不调用 AI（aria snapshot 里没有它，省调用）', async () => {
		const host = makeRef({
			tag: 'x-closed-card',
			attrs: { id: 'closed-card' },
			candidates: [
				{ kind: 'testid', value: 'nope-closed', score: 1, source: 'record' },
				{ kind: 'css', value: '#nope-closed', score: 2, source: 'record' },
			],
			fingerprint: { attrs: { id: 'nope-closed' } },
		})
		host.observed.shadowRootType = 'closed'
		host.observed.innerOffset = { x: 10, y: 10 }

		let aiCalls = 0
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: `${site}/shadow-closed` },
			{
				id: 'click-missing',
				kind: 'click',
				target: host,
				button: 'left',
				clickCount: 1,
				modifiers: [],
				position: { x: 10, y: 10 },
			},
		])
		const result = await playFlow({
			flow,
			artifactsRoot,
			headless: true,
			ai: {
				locate: async () => {
					aiCalls += 1
					return { confidence: 0.9, reason: 'should never be called' }
				},
			},
		})
		expect(result.ok).toBe(false)
		expect(result.steps[1]?.error?.code).toBe('ELEMENT_NOT_FOUND')
		expect(aiCalls).toBe(0)
	}, 90_000)

	it('baseUrl：录制在错误端口的 flow 也能在 fixture 站回放（只换 origin）', async () => {
		// 故意写一个打不通的端口：只有 baseUrl 重定基生效，这一步才可能通过
		const flow = buildFlow([
			{ id: 'nav', kind: 'navigate', url: 'http://127.0.0.1:1/basic?from=record' },
			{ id: 'fill-name', kind: 'input', target: refName(), value: '王五', clear: true },
		])
		const result = await playFlow({ flow, artifactsRoot, headless: true, baseUrl: site })
		if (!result.ok) throw new Error(`baseUrl 回放失败：${JSON.stringify(result.steps)}`)
		expect(result.steps[0]?.status).toBe('pass')

		// 再断言一次「首次 goto」（flow 首步不是 navigate 时走 env.startUrl）也会重定基
		const startUrlFlow = buildFlow([
			{ id: 'fill-only', kind: 'input', target: refName(), value: '赵六', clear: true },
		])
		const result2 = await playFlow({
			flow: startUrlFlow,
			artifactsRoot,
			headless: true,
			baseUrl: site,
		})
		expect(result2.ok).toBe(true)
	}, 90_000)

	it(`真实回放成功率：连续 ${RUNS} 次 /basic 全流程`, async () => {
		const results = await playRuns({ flow: basicFlow(), artifactsRoot, headless: true, runs: RUNS })
		const passed = results.filter((r) => r.ok).length
		const steps = results.flatMap((r) => r.steps)
		const stepPass = steps.filter((s) => s.status === 'pass').length
		// 让报告里能直接看到数字
		console.log(
			`[smoke] flows ${passed}/${RUNS} 全通过；步骤 ${stepPass}/${steps.length} 通过；` +
				`平均 ${Math.round(results.reduce((acc, r) => acc + r.metrics.totalMs, 0) / results.length)}ms/flow`,
		)
		expect(passed).toBe(RUNS)
	}, 180_000)
})

/* ------------------------------------------------------------------ */
/* 真实 recorder 产出的 flow（端到端：录制 → IR → 回放）                 */
/* ------------------------------------------------------------------ */

/**
 * 找 recorder 的产出：lead 会把 `smoke-*.json` 统一改名成 `local-<route>.json`
 * （例如 local-iframe-same.json / local-shadow-closed.json），所以按别名依次尝试；
 * 都没有就跳过（不阻塞其它冒烟）。
 */
async function findRecordedFlow(...names: string[]): Promise<string | undefined> {
	const root = fileURLToPath(new URL('../../../flows', import.meta.url))
	for (const name of names) {
		const file = join(root, name)
		try {
			const info = await stat(file)
			if (info.isFile()) return file
		} catch {
			/* 试下一个命名 */
		}
	}
	return undefined
}

describe.skipIf(!ENABLED)('冒烟: 回放 recorder 真实产出', () => {
	it('/basic 录制 flow 在 fixture 站全流程通过（baseUrl 换环境）', async () => {
		const flowPath = await findRecordedFlow('local-basic.json', 'smoke-basic.json')
		if (!flowPath) {
			console.log('[smoke] 未找到 recorder 产出的 basic flow，跳过')
			return
		}
		const { loadFlow } = await import('@rr/schema')
		const flow = await loadFlow(flowPath)
		const result = await playFlow({ flow, artifactsRoot, headless: true, baseUrl: site })
		if (!result.ok) throw new Error(`真实 flow 回放失败：${JSON.stringify(result.steps, null, 2)}`)
		expect(result.metrics.failCount).toBe(0)
		console.log(
			`[smoke] recorder flow(${flow.steps.length} 步) 回放通过；levels=` +
				JSON.stringify(result.steps.map((s) => s.level ?? '-')),
		)
	}, 120_000)

	it('同一真实 flow 抹掉全部语义候选后，L2 指纹仍能兜底（验证 hash 与录制侧一致）', async () => {
		const flowPath = await findRecordedFlow('local-basic.json', 'smoke-basic.json')
		if (!flowPath) {
			console.log('[smoke] 未找到 recorder 产出的 basic flow，跳过')
			return
		}
		const { loadFlow } = await import('@rr/schema')
		const flow = await loadFlow(flowPath)
		// 只留一条不可能命中的候选，强制走 L2
		for (const step of flow.steps) {
			if ('target' in step && step.target) {
				step.target.candidates = [
					{ kind: 'css', value: '#definitely-not-here', score: 1, source: 'record' },
				]
			}
		}
		const result = await playFlow({ flow, artifactsRoot, headless: true, baseUrl: site })
		if (!result.ok) throw new Error(`L2 兜底回放失败：${JSON.stringify(result.steps, null, 2)}`)
		const levels = result.steps.map((s) => s.level)
		console.log(`[smoke] 抹掉候选后 levels=${JSON.stringify(levels)}`)
		expect(levels.filter((l) => l === 'L2').length).toBeGreaterThanOrEqual(2)
	}, 120_000)
})

/* ------------------------------------------------------------------ */
/* 真实 recorder 产出：iframe frame 链 / closed shadow 坐标                */
/* ------------------------------------------------------------------ */

describe.skipIf(!ENABLED)('冒烟: recorder 真实产出的难点场景', () => {
	it('/iframe-same 录制 flow：frameElement + urlPattern 两级 frame 链能进入并操作', async () => {
		const flowPath = await findRecordedFlow('local-iframe-same.json', 'smoke-iframe.json', 'local-iframe.json')
		if (!flowPath) {
			console.log('[smoke] 未找到 recorder 产出的 iframe flow，跳过')
			return
		}
		const { loadFlow } = await import('@rr/schema')
		const flow = await loadFlow(flowPath)
		const result = await playFlow({ flow, artifactsRoot, headless: true, baseUrl: site })
		if (!result.ok) throw new Error(`iframe flow 回放失败：${JSON.stringify(result.steps, null, 2)}`)
		console.log(
			`[smoke] iframe flow 回放通过；levels=${JSON.stringify(result.steps.map((s) => s.level ?? '-'))}`,
		)
	}, 120_000)

	it('/shadow-closed 录制 flow：closed shadow 用 recorder 记的 position 点中内层按钮', async () => {
		const flowPath = await findRecordedFlow('local-shadow-closed.json', 'smoke-shadow.json', 'local-shadow.json')
		if (!flowPath) {
			console.log('[smoke] 未找到 recorder 产出的 shadow flow，跳过')
			return
		}
		const { loadFlow } = await import('@rr/schema')
		const flow = await loadFlow(flowPath)
		const result = await playFlow({ flow, artifactsRoot, headless: true, baseUrl: site })
		if (!result.ok) throw new Error(`shadow flow 回放失败：${JSON.stringify(result.steps, null, 2)}`)
		console.log(
			`[smoke] shadow flow 回放通过；levels=${JSON.stringify(result.steps.map((s) => s.level ?? '-'))}`,
		)
	}, 120_000)
})
