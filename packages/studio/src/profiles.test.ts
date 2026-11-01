import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	deleteProfile,
	listProfiles,
	originKeyOf,
	originOf,
	profilePathFor,
	readProfileMeta,
	storageStatePathIfExists,
	writeProfile,
} from './profiles.js'

let dir: string

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'rr-profiles-'))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

const state = (cookieValue = 'ok') => ({
	cookies: [
		{
			name: 'rr_session',
			value: cookieValue,
			domain: 'example.test',
			path: '/',
			expires: -1,
			httpOnly: false,
			secure: false,
			sameSite: 'Lax' as const,
		},
	],
	origins: [
		{ origin: 'https://example.test', localStorage: [{ name: 'rr_user', value: 'alice' }] },
	],
})

describe('profiles: 路径与命名', () => {
	it('originOf 只接受合法 URL', () => {
		expect(originOf('https://Example.Test:8443/a/b')).toBe('https://example.test:8443')
		expect(originOf('not a url')).toBeNull()
	})

	it('originKey 稳定、安全、不同 origin 不碰撞', () => {
		const a = originKeyOf('https://example.test')
		const b = originKeyOf('https://example.test')
		expect(a).toBe(b)
		expect(a).toMatch(/^[a-z0-9._-]+$/)
		expect(a).not.toBe(originKeyOf('http://example.test'))
		expect(a).not.toBe(originKeyOf('https://example.test:8443'))
		expect(originKeyOf('https://中文.example')).toMatch(/^[a-z0-9._-]+$/)
	})

	it('profilePathFor 落在 profilesDir 下', () => {
		const path = profilePathFor('/tmp/profiles', 'https://example.test')
		expect(path.startsWith('/tmp/profiles/')).toBe(true)
		expect(path.endsWith('.json')).toBe(true)
	})
})

describe('profiles: 读写/列表/删除', () => {
	it('写入后可读元信息（不返回 cookie 原文）', async () => {
		const origin = 'https://example.test'
		const meta = await writeProfile(dir, origin, state())
		expect(meta.cookieCount).toBe(1)
		expect(meta.localStorageOrigins).toBe(1)
		const read = await readProfileMeta(dir, origin)
		expect(read).toMatchObject({ origin, cookieCount: 1 })
		expect(JSON.stringify(read)).not.toContain('alice')
		const file = await readFile(profilePathFor(dir, origin), 'utf8')
		expect(file).toContain('rr_session')
	})

	it('原子写：覆盖已有 profile 后内容完整', async () => {
		const origin = 'https://example.test'
		await writeProfile(dir, origin, state('first'))
		await writeProfile(dir, origin, state('second'))
		const file = await readFile(profilePathFor(dir, origin), 'utf8')
		expect(file).toContain('second')
		expect(file).not.toContain('first')
	})

	it('坏文件/不存在 → null，列表跳过坏文件', async () => {
		expect(await readProfileMeta(dir, 'https://none.test')).toBeNull()
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, 'broken-12345678.json'), '{oops', 'utf8')
		await writeProfile(dir, 'https://ok.test', state())
		const list = await listProfiles(dir)
		expect(list).toHaveLength(1)
		expect(list[0]!.origin).toBe('https://ok.test')
	})

	it('storageStatePathIfExists：有 profile 返回路径，没有返回 null', async () => {
		const origin = 'https://example.test'
		expect(await storageStatePathIfExists(dir, origin)).toBeNull()
		await writeProfile(dir, origin, state())
		expect(await storageStatePathIfExists(dir, origin)).toBe(profilePathFor(dir, origin))
		expect(await storageStatePathIfExists(dir, null)).toBeNull()
	})

	it('删除 profile（路径安全：只删 profilesDir 下的 .json）', async () => {
		const origin = 'https://example.test'
		await writeProfile(dir, origin, state())
		const key = originKeyOf(origin)
		expect(await deleteProfile(dir, key)).toBe(true)
		expect(await readProfileMeta(dir, origin)).toBeNull()
		expect(await deleteProfile(dir, '../etc/passwd')).toBe(false)
		expect(await deleteProfile(dir, 'not-exist')).toBe(false)
	})
})
