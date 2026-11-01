/**
 * 登录态读写 + 登录过期提示（纯逻辑单测，不启浏览器）。
 *
 * 契约 docs/profiles-rerecord.md §A.2 / §A.4：
 * - 读：不存在 / 非法 JSON / 结构不对 → undefined + 日志，绝不抛；
 * - 写：原子（同目录临时文件 + rename），失败只告警；
 * - 提示：URL 命中登录页正则才追加，且幂等、不改 error.code。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	appendLoginExpiredHint,
	loadStorageState,
	LOGIN_EXPIRED_HINT,
	looksLikeLoginUrl,
	parseStorageState,
	saveContextStorageState,
	saveStorageStateAtomic,
} from './index.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'rr-storage-'))
	dirs.push(dir)
	return dir
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const sampleState = {
	cookies: [
		{
			name: 'rr_session',
			value: 'active',
			domain: '127.0.0.1',
			path: '/',
			expires: -1,
			httpOnly: false,
			secure: false,
			sameSite: 'Lax' as const,
		},
	],
	origins: [
		{ origin: 'http://127.0.0.1:5173', localStorage: [{ name: 'uid', value: '42' }] },
	],
}

describe('executor: storageState 解析', () => {
	it('合法结构通过，origins 缺省补空数组（Playwright 要求必填）', () => {
		expect(parseStorageState({ cookies: [] })).toEqual({ cookies: [], origins: [] })
		expect(parseStorageState(sampleState)?.cookies[0]?.name).toBe('rr_session')
	})

	it('非对象 / 缺 cookies / cookies 不是数组 / origins 不是数组 → undefined', () => {
		expect(parseStorageState(null)).toBeUndefined()
		expect(parseStorageState([])).toBeUndefined()
		expect(parseStorageState({})).toBeUndefined()
		expect(parseStorageState({ cookies: 'x' })).toBeUndefined()
		expect(parseStorageState({ cookies: [], origins: 'x' })).toBeUndefined()
	})
})

describe('executor: 读取登录态（容错，绝不抛）', () => {
	it('路径为空/未设置 → undefined 且不读盘', async () => {
		expect(await loadStorageState(undefined)).toBeUndefined()
		expect(await loadStorageState('   ')).toBeUndefined()
	})

	it('文件不存在 → undefined + 日志提示（按未登录回放）', async () => {
		const logs: string[] = []
		const dir = await tempDir()
		const state = await loadStorageState(join(dir, 'nope.json'), (m) => logs.push(m))
		expect(state).toBeUndefined()
		expect(logs.join('\n')).toContain('不存在')
	})

	it('非法 JSON → undefined + 日志（不抛）', async () => {
		const dir = await tempDir()
		const file = join(dir, 'bad.json')
		await writeFile(file, '{ not json', 'utf8')
		const logs: string[] = []
		expect(await loadStorageState(file, (m) => logs.push(m))).toBeUndefined()
		expect(logs.join('\n')).toContain('JSON')
	})

	it('结构不合法 → undefined + 日志', async () => {
		const dir = await tempDir()
		const file = join(dir, 'shape.json')
		await writeFile(file, JSON.stringify({ hello: 1 }), 'utf8')
		const logs: string[] = []
		expect(await loadStorageState(file, (m) => logs.push(m))).toBeUndefined()
		expect(logs.join('\n')).toContain('结构不合法')
	})

	it('合法文件 → 返回 cookies', async () => {
		const dir = await tempDir()
		const file = join(dir, 'ok.json')
		await writeFile(file, JSON.stringify(sampleState), 'utf8')
		const state = await loadStorageState(file)
		expect(state?.cookies).toHaveLength(1)
		expect(state?.origins?.[0]?.origin).toBe('http://127.0.0.1:5173')
	})
})

describe('executor: 保存登录态（原子写）', () => {
	it('写出的内容包含 cookie，且不残留临时文件', async () => {
		const dir = await tempDir()
		const file = join(dir, 'nested', 'state.json')
		expect(await saveStorageStateAtomic(file, sampleState)).toBe(true)

		const saved = JSON.parse(await readFile(file, 'utf8'))
		expect(saved.cookies[0]).toMatchObject({ name: 'rr_session', value: 'active' })
		// 原子写：目录里只有目标文件，没有 .tmp-*
		const files = await readdir(join(dir, 'nested'))
		expect(files).toEqual(['state.json'])
	})

	it('覆盖已有文件（rename 替换）', async () => {
		const dir = await tempDir()
		const file = join(dir, 'state.json')
		await writeFile(file, JSON.stringify({ cookies: [{ name: 'old' }], origins: [] }), 'utf8')
		await saveStorageStateAtomic(file, sampleState)
		const saved = JSON.parse(await readFile(file, 'utf8'))
		expect(saved.cookies[0].name).toBe('rr_session')
	})

	it('写失败（父路径是文件）→ 返回 false + 告警，不抛', async () => {
		const dir = await tempDir()
		const blocker = join(dir, 'blocked')
		await writeFile(blocker, 'x', 'utf8') // 让 blocked/ 无法作为目录创建
		const logs: string[] = []
		const ok = await saveStorageStateAtomic(join(blocker, 'state.json'), sampleState, (m) =>
			logs.push(m),
		)
		expect(ok).toBe(false)
		expect(logs.join('\n')).toContain('保存登录态失败')
	})

	it('saveContextStorageState：从 context 抓状态并落盘；path 为空直接 false', async () => {
		const dir = await tempDir()
		const file = join(dir, 'ctx.json')
		const context = { storageState: vi.fn(async () => sampleState) }
		expect(
			await saveContextStorageState(context as never, file),
		).toBe(true)
		expect(context.storageState).toHaveBeenCalled()
		expect(JSON.parse(await readFile(file, 'utf8')).cookies[0].value).toBe('active')

		expect(await saveContextStorageState(context as never, undefined)).toBe(false)
	})

	it('saveContextStorageState：context 抓取失败 → false + 告警', async () => {
		const logs: string[] = []
		const ok = await saveContextStorageState(
			{
				storageState: async () => {
					throw new Error('browser closed')
				},
			} as never,
			join(await tempDir(), 'x.json'),
			(m) => logs.push(m),
		)
		expect(ok).toBe(false)
		expect(logs.join('\n')).toContain('browser closed')
	})
})

describe('executor: 登录过期人话提示', () => {
	it('命中登录页 URL（文档给的模式）', () => {
		for (const url of [
			'https://x.test/login',
			'https://x.test/signin?next=/app',
			'https://x.test/sign-in',
			'https://x.test/auth/callback',
			'https://x.test/sso/start',
			'https://x.test/登录',
			'https://x.test/LOGIN',
		]) {
			expect(looksLikeLoginUrl(url), url).toBe(true)
		}
	})

	it('业务页面不误报', () => {
		for (const url of [
			'https://x.test/basic',
			'https://x.test/dashboard?tab=orders',
			'about:blank',
			undefined,
			'',
		]) {
			expect(looksLikeLoginUrl(url), String(url)).toBe(false)
		}
	})

	it('追加提示：只改 message，不动其它内容', () => {
		const message = 'EXPECT_MISMATCH: 期望元素可见，但不可见'
		const next = appendLoginExpiredHint(message, 'https://x.test/login')
		expect(next.startsWith(message)).toBe(true)
		expect(next).toContain(LOGIN_EXPIRED_HINT)
	})

	it('业务页失败不追加', () => {
		expect(appendLoginExpiredHint('boom', 'https://x.test/basic')).toBe('boom')
	})

	it('幂等：已有提示不重复追加', () => {
		const once = appendLoginExpiredHint('boom', 'https://x.test/login')
		const twice = appendLoginExpiredHint(once, 'https://x.test/login')
		expect(twice).toBe(once)
	})
})
