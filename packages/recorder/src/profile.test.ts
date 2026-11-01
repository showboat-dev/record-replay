/**
 * 登录态读写单测（纯 IO，不启浏览器）。
 *
 * 覆盖任务要求的四个点：读取 / 保存 / 非法 JSON 容错 / 保存是原子写。
 * 另加：两种格式（裸 storageState / Studio wrapper）互通、发生失败时旧文件不被破坏、新文件权限 0600。
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { StorageState } from './profile.js'
import { describeStorageState, isStorageState, loadProfile, saveProfile } from './profile.js'

let dir: string

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'rr-profile-'))
})

afterAll(async () => {
	await chmod(dir, 0o700).catch(() => {})
	await rm(dir, { recursive: true, force: true })
})

function state(overrides: Partial<StorageState> = {}): StorageState {
	return {
		cookies: [
			{
				name: 'rr_auth',
				value: 'token-abc',
				domain: '127.0.0.1',
				path: '/',
				expires: -1,
				httpOnly: true,
				secure: false,
				sameSite: 'Lax',
			},
		],
		origins: [{ origin: 'http://127.0.0.1:5173', localStorage: [{ name: 'rr_user', value: 'alice' }] }],
		...overrides,
	} as StorageState
}

describe('isStorageState —— 形状校验（宽进）', () => {
	it('接受 cookies + origins', () => {
		expect(isStorageState(state())).toBe(true)
		expect(isStorageState({ cookies: [], origins: [] })).toBe(true)
	})

	it('拒绝缺字段 / 非对象 / null', () => {
		expect(isStorageState({ cookies: [] })).toBe(false)
		expect(isStorageState({ origins: [] })).toBe(false)
		expect(isStorageState({ cookies: {}, origins: [] })).toBe(false)
		expect(isStorageState(null)).toBe(false)
		expect(isStorageState('x')).toBe(false)
	})
})

describe('loadProfile —— 读失败一律当「没有登录态」，不抛错', () => {
	it('路径为空 / undefined → disabled', async () => {
		expect((await loadProfile(undefined)).status).toBe('disabled')
		expect((await loadProfile('')).status).toBe('disabled')
	})

	it('文件不存在 → missing（带人话说明，不抛）', async () => {
		const result = await loadProfile(join(dir, 'nope.json'))
		expect(result.status).toBe('missing')
		expect(result.state).toBeUndefined()
		expect(result.message).toContain('不存在')
	})

	it('父路径是文件（ENOTDIR）也当 missing', async () => {
		const file = join(dir, 'a-file')
		await writeFile(file, 'x')
		expect((await loadProfile(join(file, 'child.json'))).status).toBe('missing')
	})

	it('非法 JSON → invalid，不抛', async () => {
		const path = join(dir, 'bad.json')
		await writeFile(path, '{ not json ')
		const result = await loadProfile(path)
		expect(result.status).toBe('invalid')
		expect(result.message).toContain('不是合法 JSON')
	})

	it('合法 JSON 但形状不对 → invalid', async () => {
		const path = join(dir, 'shape.json')
		await writeFile(path, JSON.stringify({ foo: 1 }))
		expect((await loadProfile(path)).status).toBe('invalid')
		await writeFile(path, JSON.stringify({ cookies: [], origins: [], extra: true, ok: 1 }))
		expect((await loadProfile(path)).status).toBe('loaded')
	})

	it('裸 Playwright storageState → loaded / raw', async () => {
		const path = join(dir, 'raw.json')
		await writeFile(path, JSON.stringify(state()))
		const result = await loadProfile(path)
		expect(result.status).toBe('loaded')
		expect(result.shape).toBe('raw')
		expect(result.state?.cookies).toHaveLength(1)
	})

	it('Studio profile wrapper → 解包 + 记住 origin / shape', async () => {
		const path = join(dir, 'wrapped.json')
		await writeFile(
			path,
			JSON.stringify({ origin: 'http://127.0.0.1:5173', savedAt: '2026-01-01T00:00:00.000Z', storageState: state() }),
		)
		const result = await loadProfile(path)
		expect(result.status).toBe('loaded')
		expect(result.shape).toBe('wrapped')
		expect(result.origin).toBe('http://127.0.0.1:5173')
		expect(result.state?.origins).toHaveLength(1)
	})
})

describe('saveProfile —— 原子写', () => {
	it('写入后可读回，且不残留临时文件', async () => {
		const target = join(dir, 'out', 'profile.json')
		const result = await saveProfile(target, state())
		expect(result.ok).toBe(true)
		const parsed = JSON.parse(await readFile(target, 'utf8'))
		expect(parsed.cookies[0].name).toBe('rr_auth')
		// 同目录不能留下 *.tmp
		const siblings = await readdir(join(dir, 'out'))
		expect(siblings.filter((name) => name.endsWith('.tmp'))).toEqual([])
	})

	it('自动创建父目录（profiles/ 可能还不存在）', async () => {
		const target = join(dir, 'deep', 'nested', 'p.json')
		expect((await saveProfile(target, state())).ok).toBe(true)
		expect(await stat(target)).toBeTruthy()
	})

	it('覆盖已有文件：内容整体替换，不会新旧混合', async () => {
		const target = join(dir, 'overwrite.json')
		await saveProfile(target, state())
		const updated = state({ cookies: [] })
		await saveProfile(target, updated)
		const parsed = JSON.parse(await readFile(target, 'utf8'))
		expect(parsed.cookies).toEqual([])
		expect(parsed.origins).toHaveLength(1)
	})

	it('新文件权限 0600（含凭证，不让同机其他用户读）', async () => {
		const target = join(dir, 'perm', 'p.json')
		await saveProfile(target, state())
		const mode = (await stat(target)).mode & 0o777
		expect(mode).toBe(0o600)
	})

	it('写失败时不破坏已有合法 profile（返回 ok:false，不抛）', async () => {
		const readonlyDir = join(dir, 'readonly')
		await mkdir(readonlyDir, { recursive: true })
		const target = join(readonlyDir, 'p.json')
		await saveProfile(target, state())
		const before = await readFile(target, 'utf8')

		// 目录设为不可写 → 临时文件创建失败（模拟磁盘满/权限问题）
		await chmod(readonlyDir, 0o500)
		try {
			const result = await saveProfile(target, state({ cookies: [] }))
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
			// 旧文件必须原封不动
			expect(await readFile(target, 'utf8')).toBe(before)
		} finally {
			await chmod(readonlyDir, 0o700)
		}
	})

	it('形状不合法直接拒绝（不写盘）', async () => {
		const target = join(dir, 'bad-state.json')
		const result = await saveProfile(target, { cookies: 'x' } as unknown as StorageState)
		expect(result.ok).toBe(false)
		await expect(stat(target)).rejects.toThrow()
	})

	it('wrapper 形状：保留 origin/savedAt 结构（Studio 的 profiles/ 不会被写坏）', async () => {
		const target = join(dir, 'wrapped-out.json')
		await saveProfile(target, state(), {
			shape: 'wrapped',
			origin: 'http://127.0.0.1:5173',
			savedAt: '2026-02-02T00:00:00.000Z',
		})
		const parsed = JSON.parse(await readFile(target, 'utf8'))
		expect(parsed.origin).toBe('http://127.0.0.1:5173')
		expect(parsed.savedAt).toBe('2026-02-02T00:00:00.000Z')
		expect(parsed.storageState.cookies).toHaveLength(1)
		// 存完还能被 loadProfile 解包读回（round-trip）
		const reread = await loadProfile(target)
		expect(reread.status).toBe('loaded')
		expect(reread.shape).toBe('wrapped')
	})
})

describe('saveProfile → loadProfile round-trip（两种形状）', () => {
	it('raw：写→读一致', async () => {
		const target = join(dir, 'rt-raw.json')
		await saveProfile(target, state())
		const result = await loadProfile(target)
		expect(result.shape).toBe('raw')
		expect(result.state).toEqual(state())
	})

	it('wrapped：写→读一致，并保留 origin', async () => {
		const target = join(dir, 'rt-wrapped.json')
		await saveProfile(target, state(), { shape: 'wrapped', origin: 'http://a.test' })
		const result = await loadProfile(target)
		expect(result.state).toEqual(state())
		expect(result.origin).toBe('http://a.test')
	})
})

describe('describeStorageState —— 日志摘要不泄露值', () => {
	it('只报数量', () => {
		const text = describeStorageState(state())
		expect(text).toContain('1 个 cookie')
		expect(text).toContain('1 个含 localStorage')
		expect(text).not.toContain('token-abc')
	})

	it('无登录态', () => {
		expect(describeStorageState(undefined)).toBe('无登录态')
	})
})
