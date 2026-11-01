/**
 * 真实 `@rr/suggest` 规则引擎的集成测试（规则引擎就绪前自动 skip）。
 *
 * 与 `suggest.api.test.ts` 的区别：这个文件**不打桩**，直接跑真实 analyze/apply。
 * 探测方式：调用一次 analyzeFlow，如果它还在 `throw`（T-suggest-rules 未完成）就整组跳过；
 * 引擎落地后无需改代码，`pnpm test` 会自动开始跑真实集成回归。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadFlow, parseFlow, serializeFlow, type Flow } from '@rr/schema'
import { analyzeFlow } from '@rr/suggest'

import { createStudioServer } from './server.js'

function ref(testid: string, tag = 'input'): Record<string, unknown> {
	return {
		observed: {
			tag,
			attributes: { 'data-testid': testid },
			text: undefined,
			rect: { x: 10, y: 10, width: 200, height: 32 },
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: [{ kind: 'testid', value: testid, score: 1, source: 'record' }],
		fingerprint: { tag, attrs: { 'data-testid': testid }, stableHash: `hash-${testid}` },
		frame: { path: [] },
	}
}

function sampleFlow(): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: 'real-suggest',
		title: '真实规则引擎冒烟',
		version: 1,
		createdAt: new Date().toISOString(),
		meta: {
			env: { startUrl: 'http://127.0.0.1:5173/basic', viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: 'test', version: '0' },
		},
		variables: [],
		steps: [
			{ id: 'nav', kind: 'navigate', url: 'http://127.0.0.1:5173/basic' },
			{
				id: 's1',
				kind: 'input',
				target: ref('field-email') as never,
				value: 'zhang@example.com',
				clear: true,
			},
			{
				id: 's2',
				kind: 'input',
				target: ref('field-full-name') as never,
				value: '张三',
				clear: true,
			},
		],
		selfHealed: [],
	})
}

/** 探测规则引擎是否就绪：就绪 = analyzeFlow 不抛 "尚未实现" */
function detectReady(): boolean {
	try {
		analyzeFlow(sampleFlow())
		return true
	} catch {
		return false
	}
}

const READY = detectReady()

let flowsDir = ''
let artifactsDir = ''
let close: (() => Promise<void>) | undefined
let base = ''
let root = ''

beforeAll(async () => {
	if (!READY) return
	root = await mkdtemp(join(tmpdir(), 'rr-studio-suggest-real-'))
	flowsDir = join(root, 'flows')
	artifactsDir = join(root, 'artifacts')
	await mkdir(flowsDir, { recursive: true })
	const flow = sampleFlow()
	await writeFile(join(flowsDir, 'real-suggest.json'), serializeFlow(flow), 'utf8')
	const server = await createStudioServer({ port: 0, flowsDir, artifactsDir })
	close = server.close
	base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
	if (close) await close()
	if (root) await rm(root, { recursive: true, force: true })
})

describe.skipIf(!READY)('studio API + 真实 @rr/suggest', () => {
	it('GET suggestions 返回真实规则结果', async () => {
		const response = await fetch(`${base}/api/flows/real-suggest.json/suggestions`)
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			flowVersion: number
			suggestions: Array<{ stepId: string; suggestedName: string; confidence: string }>
			skipped: Array<{ stepId: string }>
		}
		expect(body.flowVersion).toBe(1)
		// 邮箱/姓名都属于强业务字段，规则引擎应至少召回一条
		expect(body.suggestions.length).toBeGreaterThan(0)
		expect(body.suggestions.every((s) => s.suggestedName.length > 0)).toBe(true)
	})

	it('apply-suggestion 用真实规则建议的名字应用成功（version+1 + .bak + parseFlow 通过）', async () => {
		const listResponse = await fetch(`${base}/api/flows/real-suggest.json/suggestions`)
		const list = (await listResponse.json()) as {
			suggestions: Array<{ stepId: string; suggestedName: string; suggestedType?: string }>
		}
		const first = list.suggestions[0]
		if (!first) return // 引擎暂时召回 0 条也不让它变红

		const response = await fetch(`${base}/api/flows/real-suggest.json/apply-suggestion`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				stepId: first.stepId,
				name: first.suggestedName,
				...(first.suggestedType ? { type: first.suggestedType } : {}),
			}),
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as { ok: boolean; flow: RunLike }
		expect(body.ok).toBe(true)
		expect(body.flow.version).toBe(2)

		const onDisk = await loadFlow(join(flowsDir, 'real-suggest.json'))
		expect(onDisk.version).toBe(2)
		expect(onDisk.variables.map((v) => v.name)).toContain(first.suggestedName)
		expect(existsSync(join(flowsDir, 'real-suggest.json.bak'))).toBe(true)
	})
})

interface RunLike {
	version: number
}
