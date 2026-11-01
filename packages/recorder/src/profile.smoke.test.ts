/**
 * 登录态真实浏览器冒烟（默认跳过，`RR_SMOKE=1 pnpm test` 才跑）。
 *
 * 为什么默认跳过：`pnpm test` 要快、且不依赖浏览器缓存。这与 executor 的
 * `play.smoke.test.ts` 保持同一约定。
 *
 * 自带一个零依赖 http 服务器（不依赖 fixture 站是否加了 `/login` `/protected`），
 * 覆盖四条真实链路：
 * 1. 录制 + `saveStorageStatePath` → 停时写出 profile，里面有 auth cookie + localStorage；
 * 2. 录制 + `storageStatePath` → 页面**首次加载就是已登录**（不用再登一次）；
 * 3. `storageStatePath` 指向不存在的文件 → 当未登录继续录，不报错；
 * 4. `drive` 抛错 → record() 抛错，但登录态**仍然被保存**（用户已经登录过了）。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadFlow } from '@rr/schema'

import { record } from './record.js'
import { loadProfile, saveProfile, type StorageState } from './profile.js'

const ENABLED = process.env.RR_SMOKE === '1'

const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><body>
<button data-testid="do-login" onclick="doLogin()">登录（写入 cookie + localStorage）</button>
<div data-testid="who">未登录</div>
<script>
async function doLogin() {
	await fetch('/api/login', { method: 'POST' })
	localStorage.setItem('rr_user', 'alice')
	location.href = '/protected'
}
</script></body></html>`

const PROTECTED_PAGE = (loggedIn: boolean) => `<!doctype html><html lang="zh-CN"><body>
<h1>受保护页面</h1>
<div data-testid="who">${loggedIn ? '已登录 alice' : '未登录'}</div>
<button data-testid="refresh" onclick="location.reload()">刷新</button>
</body></html>`

function cookieOf(request: IncomingMessage, name: string): string | undefined {
	const header = request.headers.cookie
	if (!header) return undefined
	for (const part of header.split(';')) {
		const [key, ...rest] = part.trim().split('=')
		if (key === name) return rest.join('=')
	}
	return undefined
}

/** 读某 testid 的可见文本（等它出现，避免和首帧竞速） */
async function textOf(page: import('playwright').Page, testId: string): Promise<string> {
	const locator = page.getByTestId(testId)
	await locator.waitFor({ state: 'visible', timeout: 10_000 })
	return (await locator.innerText()).trim()
}

function handler(request: IncomingMessage, response: ServerResponse): void {
	const url = new URL(request.url ?? '/', 'http://127.0.0.1')
	if (url.pathname === '/api/login') {
		response.writeHead(200, {
			'Content-Type': 'application/json; charset=utf-8',
			'Set-Cookie': 'rr_auth=token-abc; Path=/; HttpOnly; SameSite=Lax',
		})
		response.end('{"ok":true}')
		return
	}
	response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
	if (url.pathname === '/login') {
		response.end(LOGIN_PAGE)
		return
	}
	if (url.pathname === '/protected') {
		response.end(PROTECTED_PAGE(!!cookieOf(request, 'rr_auth')))
		return
	}
	response.end('<!doctype html><html><body>ok</body></html>')
}

describe.skipIf(!ENABLED)('登录态冒烟（真实 Chromium）', () => {
	let server: Server
	let baseUrl: string
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'rr-profile-smoke-'))
		server = createServer(handler)
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
		await rm(dir, { recursive: true, force: true })
	})

	it('录制 + saveStorageStatePath → 停时写出含 auth cookie 的 profile', async () => {
		const profilePath = join(dir, 'profiles', 'saved.json')
		const outPath = join(dir, 'flows', 'login.json')
		const result = await record({
			startUrl: `${baseUrl}/login`,
			outPath,
			headless: true,
			artifactsRoot: join(dir, 'artifacts'),
			saveStorageStatePath: profilePath,
			drive: async (page) => {
				await page.getByTestId('do-login').click()
				await page.waitForURL('**/protected')
				expect(await textOf(page, 'who')).toBe('已登录 alice')
				await page.waitForTimeout(300)
			},
		})

		// flow 正常落盘且可解析
		const flow = await loadFlow(outPath)
		expect(flow.steps.length).toBeGreaterThanOrEqual(1)
		expect(flow.id).toBe(result.flow.id)

		// profile 文件写出，且里面有 auth cookie + localStorage
		const loaded = await loadProfile(profilePath)
		expect(loaded.status).toBe('loaded')
		const cookies = loaded.state?.cookies as Array<{ name: string; value: string }>
		expect(cookies.some((cookie) => cookie.name === 'rr_auth' && cookie.value === 'token-abc')).toBe(true)
		const origins = loaded.state?.origins as Array<{
			origin: string
			localStorage?: Array<{ name: string; value: string }>
		}>
		const entry = origins.find((origin) => origin.origin === baseUrl)
		expect(entry?.localStorage?.some((item) => item.name === 'rr_user')).toBe(true)
	})

	it('录制 + storageStatePath → 页面首次加载即已登录（不用再登）', async () => {
		const profilePath = join(dir, 'profiles', 'saved.json')
		const outPath = join(dir, 'flows', 'reuse.json')
		let sawLoggedInOnLoad = false

		const result = await record({
			startUrl: `${baseUrl}/protected`,
			outPath,
			headless: true,
			artifactsRoot: join(dir, 'artifacts'),
			storageStatePath: profilePath,
			drive: async (page) => {
				// 关键断言：没有任何登录动作，/protected 直接是已登录态
				expect(await textOf(page, 'who')).toBe('已登录 alice')
				sawLoggedInOnLoad = true
				await page.getByTestId('refresh').click()
				await page.waitForTimeout(200)
			},
		})

		expect(sawLoggedInOnLoad).toBe(true)
		expect(result.flow.meta.env.startUrl).toBe(`${baseUrl}/protected`)
		expect((await loadFlow(outPath)).steps.length).toBeGreaterThanOrEqual(1)
	})

	it('storageStatePath 不存在 → 当未登录继续录，不报错', async () => {
		const outPath = join(dir, 'flows', 'no-profile.json')
		const result = await record({
			startUrl: `${baseUrl}/protected`,
			outPath,
			headless: true,
			artifactsRoot: join(dir, 'artifacts'),
			storageStatePath: join(dir, 'profiles', 'does-not-exist.json'),
			drive: async (page) => {
				// 没有 profile → 未登录
				expect(await textOf(page, 'who')).toBe('未登录')
				await page.getByTestId('refresh').click()
				await page.waitForTimeout(200)
			},
		})
		expect((await loadFlow(outPath)).steps.length).toBeGreaterThanOrEqual(1)
		expect(result.flow.steps.length).toBeGreaterThanOrEqual(1)
	})

	it('profile 形状合法但浏览器不接受（坏 sameSite）→ 丢登录态重试，录制照常完成', async () => {
		const broken = join(dir, 'profiles', 'broken.json')
		await saveProfile(broken, {
			cookies: [
				{
					name: 'rr_auth',
					value: 'x',
					domain: '127.0.0.1',
					path: '/',
					expires: -1,
					httpOnly: true,
					secure: false,
					// Playwright 会校验枚举值：这里故意写错，newContext 会抛
					sameSite: 'Bogus',
				},
			],
			origins: [],
		} as unknown as StorageState)
		const outPath = join(dir, 'flows', 'broken-profile.json')
		const result = await record({
			startUrl: `${baseUrl}/protected`,
			outPath,
			headless: true,
			artifactsRoot: join(dir, 'artifacts'),
			storageStatePath: broken,
			drive: async (page) => {
				// 登录态被丢弃 → 未登录，但录制正常继续
				expect(await textOf(page, 'who')).toBe('未登录')
				await page.getByTestId('refresh').click()
				await page.waitForTimeout(200)
			},
		})
		expect(result.flow.steps.length).toBeGreaterThanOrEqual(1)
	})

	it('drive 抛错 → record 抛错，但登录态仍然保存', async () => {
		const profilePath = join(dir, 'profiles', 'after-error.json')
		const outPath = join(dir, 'flows', 'error.json')
		await expect(
			record({
				startUrl: `${baseUrl}/login`,
				outPath,
				headless: true,
				artifactsRoot: join(dir, 'artifacts'),
				saveStorageStatePath: profilePath,
				drive: async (page) => {
					await page.getByTestId('do-login').click()
					await page.waitForURL('**/protected')
					throw new Error('模拟 drive 中途失败')
				},
			}),
		).rejects.toThrow(/drive 回调失败/)

		// 半截 flow 不落盘，但登录态要留下
		const loaded = await loadProfile(profilePath)
		expect(loaded.status).toBe('loaded')
		const cookies = loaded.state?.cookies as Array<{ name: string; value: string }>
		expect(cookies.some((cookie) => cookie.name === 'rr_auth')).toBe(true)
		await expect(readFile(outPath, 'utf8')).rejects.toThrow()
	})
})
