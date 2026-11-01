/**
 * 登录态 + 单步重录 API 测试（不启动真实浏览器；重录的 replace 用临时 flow 文件验证核心逻辑）。
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadFlow, parseFlow } from '@rr/schema'

import { createStudioServer } from './server.js'
import { originKeyOf, writeProfile } from './profiles.js'

const repoFlows = join(import.meta.dirname, '..', '..', '..', 'flows')

let dir: string
let base: string
let close: () => Promise<void>
let profilesDir: string
let flowsDir: string

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'rr-sprint1-api-'))
	flowsDir = join(dir, 'flows')
	profilesDir = join(dir, 'profiles')
	await cp(join(repoFlows, 'local-basic.json'), join(dir, 'flows', 'local-basic.json')).catch(
		async () => {
			// 目录不存在时 cp 失败：先建目录再拷
			await rm(join(dir, 'flows'), { recursive: true, force: true })
			await (await import('node:fs/promises')).mkdir(join(dir, 'flows'), { recursive: true })
			await cp(join(repoFlows, 'local-basic.json'), join(dir, 'flows', 'local-basic.json'))
		},
	)
	const server = await createStudioServer({
		port: 0,
		flowsDir,
		artifactsDir: join(dir, 'artifacts'),
		profilesDir,
	})
	base = `http://127.0.0.1:${server.port}`
	close = server.close
})
afterEach(async () => {
	await close?.()
	await rm(dir, { recursive: true, force: true })
})

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
	})
	return { status: res.status, body: await res.json().catch(() => null) }
}

describe('profiles API', () => {
	it('GET /api/profiles 空 → []，写入后可见', async () => {
		expect((await api('/api/profiles')).body.profiles).toEqual([])
		await writeProfile(profilesDir, 'https://example.test', { cookies: [], origins: [] })
		const list = (await api('/api/profiles')).body.profiles
		expect(list).toHaveLength(1)
		expect(list[0].origin).toBe('https://example.test')
	})

	it('DELETE /api/profiles/:key', async () => {
		await writeProfile(profilesDir, 'https://example.test', { cookies: [], origins: [] })
		const key = originKeyOf('https://example.test')
		expect((await api(`/api/profiles/${key}`, { method: 'DELETE' })).status).toBe(200)
		expect((await api(`/api/profiles/${key}`, { method: 'DELETE' })).status).toBe(404)
	})

	it('login/start 缺 url / 非法 url → 400', async () => {
		expect((await api('/api/profiles/login/start', { method: 'POST', body: '{}' })).status).toBe(
			400,
		)
		expect(
			(
				await api('/api/profiles/login/start', {
					method: 'POST',
					body: JSON.stringify({ url: 'oops' }),
				})
			).status,
		).toBe(400)
	})

	it('login/stop 未知会话 → 400；cancel 未知会话 → 200', async () => {
		expect(
			(
				await api('/api/profiles/login/stop', {
					method: 'POST',
					body: JSON.stringify({ sessionId: 'nope' }),
				})
			).status,
		).toBe(400)
		expect(
			(
				await api('/api/profiles/login/cancel', {
					method: 'POST',
					body: JSON.stringify({ sessionId: 'nope' }),
				})
			).status,
		).toBe(200)
	})
})

describe('单步重录：replace API', () => {
	it('用候选步骤替换目标步骤：保留原 id、version+1、写 .bak、parseFlow 通过', async () => {
		const original = await loadFlow(join(flowsDir, 'local-basic.json'))
		const target = original.steps[1]!
		expect(target.kind).toBe('input')

		// 构造"候选录制"的临时 flow（复制原 flow，把第二个 input 的值改成新值）
		const tempDir = join(flowsDir, '.rerecord')
		await (await import('node:fs/promises')).mkdir(tempDir, { recursive: true })
		const tempFlow = structuredClone(original)
		tempFlow.steps = tempFlow.steps.map((step, i) =>
			i === 1 ? ({ ...step, value: 'replaced@example.com' } as typeof step) : step,
		)
		await writeFile(join(tempDir, 'rr-test.json'), JSON.stringify(tempFlow, null, 2), 'utf8')

		const res = await api(`/api/flows/local-basic.json/steps/${target.id}/replace`, {
			method: 'POST',
			body: JSON.stringify({
				tempFile: '.rerecord/rr-test.json',
				tempStepId: tempFlow.steps[1]!.id,
			}),
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)

		const updated = parseFlow(
			JSON.parse(await readFile(join(flowsDir, 'local-basic.json'), 'utf8')),
		)
		expect(updated.version).toBe(original.version + 1)
		expect(updated.steps[1]!.id).toBe(target.id)
		expect(JSON.stringify(updated.steps[1])).toContain('replaced@example.com')
		expect(existsSync(join(flowsDir, 'local-basic.json.bak'))).toBe(true)
		expect(existsSync(join(tempDir, 'rr-test.json'))).toBe(false)
	})

	it('非法 tempFile / 不存在的候选步骤 → 400', async () => {
		const badPath = await api('/api/flows/local-basic.json/steps/s1/replace', {
			method: 'POST',
			body: JSON.stringify({ tempFile: '../../etc/passwd', tempStepId: 'x' }),
		})
		expect(badPath.status).toBe(400)

		const tempDir = join(flowsDir, '.rerecord')
		await (await import('node:fs/promises')).mkdir(tempDir, { recursive: true })
		await writeFile(
			join(tempDir, 'rr-empty.json'),
			JSON.stringify(await loadFlow(join(flowsDir, 'local-basic.json'))),
			'utf8',
		)
		const missing = await api('/api/flows/local-basic.json/steps/s1/replace', {
			method: 'POST',
			body: JSON.stringify({ tempFile: '.rerecord/rr-empty.json', tempStepId: 'ghost' }),
		})
		expect(missing.status).toBe(400)
	})

	it('rerecord/start 对不存在的 flow / step → 404/400', async () => {
		expect(
			(await api('/api/flows/nope.json/steps/s1/rerecord/start', { method: 'POST', body: '{}' }))
				.status,
		).toBe(404)
		expect(
			(
				await api('/api/flows/local-basic.json/steps/ghost/rerecord/start', {
					method: 'POST',
					body: '{}',
				})
			).status,
		).toBe(400)
	})
})
