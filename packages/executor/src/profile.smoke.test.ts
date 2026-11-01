/**
 * 登录态（storageState）真实浏览器冒烟（默认跳过，`RR_SMOKE=1` 才跑）。
 *
 * 自带最小"带登录"站点（零依赖 http server）：
 * - `GET /login`：页面按钮设置 `rr_session=active` cookie；
 * - `GET /protected`：服务端检查 Cookie，没有就 302 回 /login（真实站点的典型行为）；
 * - `GET /open`：不需要登录的页面（用来验证"没有登录态也能跑"）。
 *
 * 覆盖：run 结束保存登录态 → 新 context 直接用同一份文件进入受保护页；
 *      没有登录态 → 被重定向到 /login → 失败信息带"登录状态可能已过期"（URL 启发式）；
 *      登录态文件不存在/非法 → 忽略继续回放（不影响流程）。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makeId, parseFlow, type ElementRef, type Flow, type Step } from '@rr/schema'
import { computeStableHash } from '@rr/resolver'

import { LOGIN_EXPIRED_HINT, playFlow } from './index.js'

const ENABLED = process.env.RR_SMOKE === '1'

const PAGES: Record<string, string> = {
	'/login': `<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head><body>
<h1>请登录</h1>
<button type="button" id="do-login" data-testid="do-login"
  onclick="document.cookie='rr_session=active; path=/; max-age=3600';document.getElementById('login-status').textContent='已登录'">
  模拟登录
</button>
<div id="login-status" role="status" data-testid="login-status"></div>
</body></html>`,
	'/protected': `<!doctype html><html><head><meta charset="utf-8"><title>受保护页</title></head><body>
<h1>受保护页</h1>
<div id="protected-content" data-testid="protected-content" role="status">机密内容：只有登录后可见</div>
</body></html>`,
	'/open': `<!doctype html><html><head><meta charset="utf-8"><title>公开页</title></head><body>
<h1>公开页</h1><div id="open-content" data-testid="open-content" role="status">公开内容</div>
</body></html>`,
}

let server: Server | undefined
let site = ''
let workDir = ''

async function startSite(): Promise<{ server: Server; site: string }> {
	const httpServer = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const cookie = req.headers.cookie ?? ''
		const loggedIn = cookie.split(';').some((part) => part.trim() === 'rr_session=active')

		if (url.pathname === '/protected' && !loggedIn) {
			// 真实站点行为：未登录 → 跳登录页
			res.writeHead(302, { location: '/login' })
			res.end()
			return
		}
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

function buildFlow(steps: Step[], startUrl = `${site}/login`): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: makeId('profile'),
		title: '登录态冒烟',
		version: 1,
		createdAt: new Date().toISOString(),
		meta: {
			env: { startUrl, viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: 'smoke', version: '0.0.1' },
		},
		variables: [],
		steps,
		selfHealed: [],
	})
}

/** 登录流程：进 /login → 点"模拟登录" → 校验状态文本 */
function loginFlow(): Flow {
	return buildFlow([
		{ id: 'nav-login', kind: 'navigate', url: `${site}/login` },
		{
			id: 'click-login',
			kind: 'click',
			target: ref('do-login', 'button'),
			button: 'left',
			clickCount: 1,
			modifiers: [],
		},
		{
			id: 'assert-logged-in',
			kind: 'assert',
			target: ref('login-status'),
			assertion: { kind: 'text', contains: '已登录' },
		},
	])
}

/** 受保护页流程（需要登录态，否则会被重定向到 /login） */
function protectedFlow(): Flow {
	return buildFlow(
		[
			{ id: 'nav-protected', kind: 'navigate', url: `${site}/protected` },
			{
				id: 'assert-protected',
				kind: 'assert',
				target: ref('protected-content'),
				assertion: { kind: 'text', contains: '机密内容' },
			},
		],
		`${site}/protected`,
	)
}

beforeAll(async () => {
	if (!ENABLED) return
	const started = await startSite()
	server = started.server
	site = started.site
	workDir = await mkdtemp(join(tmpdir(), 'rr-profile-smoke-'))
}, 30_000)

afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
	if (workDir) await rm(workDir, { recursive: true, force: true })
})

describe.skipIf(!ENABLED)('冒烟: 登录态 storageState', () => {
	it('run 结束保存登录态：文件里有 rr_session cookie，且无临时文件残留', async () => {
		const statePath = join(workDir, 'site.state.json')
		const result = await playFlow({
			flow: loginFlow(),
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
			saveStorageStatePath: statePath,
		})
		if (!result.ok) throw new Error(`登录流程失败：${JSON.stringify(result.steps, null, 2)}`)

		const saved = JSON.parse(await readFile(statePath, 'utf8')) as {
			cookies: Array<{ name: string; value: string }>
		}
		expect(saved.cookies.some((c) => c.name === 'rr_session' && c.value === 'active')).toBe(true)
		// 原子写：目录里没有 .tmp-* 残留
		const files = await readdir(workDir)
		expect(files.filter((f) => f.includes('.tmp-'))).toEqual([])
	}, 120_000)

	it('保存过的登录态能让新 context 直接进入受保护页', async () => {
		const statePath = join(workDir, 'reuse.state.json')
		const login = await playFlow({
			flow: loginFlow(),
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
			saveStorageStatePath: statePath,
		})
		expect(login.ok).toBe(true)

		const protectedRun = await playFlow({
			flow: protectedFlow(),
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
			storageStatePath: statePath,
		})
		if (!protectedRun.ok) {
			throw new Error(`带登录态回放失败：${JSON.stringify(protectedRun.steps, null, 2)}`)
		}
	}, 120_000)

	it('没有登录态：被重定向到 /login，失败信息追加"登录状态可能已过期"（code 不变）', async () => {
		const afterFailStatePath = join(workDir, 'after-fail.state.json')
		const result = await playFlow({
			flow: protectedFlow(),
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
			// 失败也要写回登录态（契约：无论成败）；调小等待让用例快
			saveStorageStatePath: afterFailStatePath,
			elementWaitMs: 800,
		})
		expect(result.ok).toBe(false)
		// 失败 run 也写回了登录态文件（内容是未登录态/空 cookie 也算写成功）
		const savedAfterFail = JSON.parse(await readFile(afterFailStatePath, 'utf8')) as {
			cookies: unknown[]
		}
		expect(Array.isArray(savedAfterFail.cookies)).toBe(true)
		const failed = result.steps.find((s) => s.status === 'fail')
		expect(failed).toBeTruthy()
		// code 语义不变（断言失败仍是 EXPECT_MISMATCH，不是被提示改写）
		expect(failed?.error?.code).toBe('EXPECT_MISMATCH')
		expect(failed?.error?.message).toContain(LOGIN_EXPIRED_HINT)
	}, 120_000)

	it('登录态文件不存在 / 非法 JSON：忽略并继续（不影响公开页回放）', async () => {
		const openFlow = buildFlow(
			[
				{ id: 'nav-open', kind: 'navigate', url: `${site}/open` },
				{
					id: 'assert-open',
					kind: 'assert',
					target: ref('open-content'),
					assertion: { kind: 'text', contains: '公开内容' },
				},
			],
			`${site}/open`,
		)

		const missing = await playFlow({
			flow: openFlow,
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
			storageStatePath: join(workDir, 'no-such-state.json'),
		})
		expect(missing.ok).toBe(true)

		const badPath = join(workDir, 'bad.state.json')
		await writeFile(badPath, '{ this is not json', 'utf8')
		const invalid = await playFlow({
			flow: openFlow,
			headless: true,
			artifactsRoot: join(workDir, 'artifacts'),
			storageStatePath: badPath,
		})
		expect(invalid.ok).toBe(true)
	}, 120_000)
})
