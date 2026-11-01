/**
 * Studio 参数化建议 API 的集成测试（临时端口 + 临时 flows 目录）。
 *
 * 为什么 mock `@rr/suggest`：规则引擎（T-suggest-rules）在并行开发中，当前 analyze/apply 都是
 * throw 占位。这里用**等价语义的桩**验证 4 条路由的契约（version 只 +1、批量先校验后落盘、
 * .bak、错误码映射、includeWeak 透传）。规则引擎就绪后，`suggest.api.real.test.ts` 会自动启用真实集成。
 *
 * 注意：绝不使用 4400 端口、绝不读写仓库里的 flows/ —— 每个用例都用自己的临时目录 + port:0。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadFlow, parseFlow, serializeFlow, type Flow, type Step } from '@rr/schema'
import { SuggestError } from '@rr/suggest'

/* ------------------------------------------------------------------ */
/* @rr/suggest 桩：语义与真实现约定一致（纯函数、非法输入抛 SuggestError）   */
/* ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
	calls: {
		analyze: [] as Array<{ flowVersion: number; includeWeak?: boolean }>,
		applySuggestion: [] as unknown[],
		applySuggestions: [] as unknown[],
		renameVariable: [] as unknown[],
	},
}))

vi.mock('@rr/suggest', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@rr/suggest')>()

	const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
	const TEMPLATE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/

	function collectSteps(steps: Step[]): Step[] {
		const out: Step[] = []
		for (const step of steps) {
			if (step.kind === 'group') out.push(...collectSteps(step.steps))
			else out.push(step)
		}
		return out
	}

	function valueOf(step: Step): string | undefined {
		if (step.kind === 'input') return step.value
		if (step.kind === 'select') return Array.isArray(step.value) ? undefined : step.value
		return undefined
	}

	function withValue(step: Step, value: string): Step {
		if (step.kind === 'input') return { ...step, value }
		if (step.kind === 'select') return { ...step, value }
		return step
	}

	function analyzeFlow(flow: Flow, opts: { includeWeak?: boolean } = {}) {
		h.calls.analyze.push({ flowVersion: flow.version, ...(opts.includeWeak !== undefined ? { includeWeak: opts.includeWeak } : {}) })
		const suggestions: Array<Record<string, unknown>> = []
		const skipped: Array<{ stepId: string; stepIndex: number; reason: string }> = []
		collectSteps(flow.steps).forEach((step, stepIndex) => {
			const value = valueOf(step)
			if (value === undefined) {
				skipped.push({ stepId: step.id, stepIndex, reason: '不是可参数化的输入步骤' })
				return
			}
			if (TEMPLATE_RE.test(value)) {
				skipped.push({ stepId: step.id, stepIndex, reason: '已经是模板' })
				return
			}
			const weak = value.length <= 1
			if (weak && !opts.includeWeak) return
			suggestions.push({
				stepId: step.id,
				kind: step.kind,
				currentValue: value,
				target: { tag: 'input', stepIndex },
				suggestedName: `field_${stepIndex + 1}`,
				suggestedType: 'string',
				confidence: weak ? 'weak' : 'high',
				reasons: ['桩：规则命中'],
			})
		})
		return {
			generatedAt: new Date().toISOString(),
			flowVersion: flow.version,
			suggestions,
			skipped,
		}
	}

	function applyOne(flow: Flow, input: { stepId: string; name: string; type?: string; applySameValue?: boolean }) {
		if (!NAME_RE.test(input.name)) {
			throw new actual.SuggestError('INVALID_NAME', `变量名 "${input.name}" 不合法（只允许字母/数字/下划线，且不能数字开头）`)
		}
		const existing = flow.variables.find((v) => v.name === input.name)
		if (existing && existing.type !== (input.type ?? existing.type)) {
			throw new actual.SuggestError('NAME_CONFLICT', `变量 "${input.name}" 已存在且类型不同`)
		}
		const all = collectSteps(flow.steps)
		const target = all.find((s) => s.id === input.stepId)
		if (!target) throw new actual.SuggestError('STEP_NOT_FOUND', `步骤 ${input.stepId} 不存在`)
		const value = valueOf(target)
		if (value === undefined) {
			throw new actual.SuggestError('UNSUPPORTED_STEP', `步骤 ${input.stepId} 不支持参数化`)
		}
		if (TEMPLATE_RE.test(value)) {
			throw new actual.SuggestError('VALUE_ALREADY_TEMPLATED', `步骤 ${input.stepId} 的值已经是模板`)
		}

		const changed = new Set<string>()
		const shouldApply = (step: Step) => step.id === input.stepId || (input.applySameValue === true && valueOf(step) === value)
		const mapSteps = (steps: Step[]): Step[] =>
			steps.map((step) => {
				if (step.kind === 'group') return { ...step, steps: mapSteps(step.steps) }
				if (!shouldApply(step)) return step
				changed.add(step.id)
				return withValue(step, `{{${input.name}}}`)
			})

		const variables = [...flow.variables]
		if (!existing) {
			variables.push({
				name: input.name,
				type: (input.type ?? 'string') as never,
				secret: false,
				source: 'input',
			})
		}
		return { flow: { ...flow, steps: mapSteps(flow.steps), variables }, changedStepIds: [...changed] }
	}

	return {
		...actual,
		analyzeFlow: (flow: Flow, opts?: { includeWeak?: boolean }) => analyzeFlow(flow, opts),
		applySuggestion: (flow: Flow, input: never) => {
			h.calls.applySuggestion.push(input)
			return applyOne(flow, input)
		},
		applySuggestions: (flow: Flow, inputs: never[]) => {
			h.calls.applySuggestions.push(inputs)
			// 先整体校验（真实现也是"先校验后应用"）：任何一条非法就抛，调用方不会落盘
			let current = flow
			const changed: string[] = []
			for (const input of inputs) {
				const result = applyOne(current, input)
				current = result.flow
				changed.push(...result.changedStepIds)
			}
			return { flow: current, changedStepIds: changed }
		},
		renameVariable: (flow: Flow, from: string, to: string) => {
			h.calls.renameVariable.push({ from, to })
			if (!NAME_RE.test(to)) {
				throw new actual.SuggestError('INVALID_NAME', `变量名 "${to}" 不合法`)
			}
			if (!flow.variables.some((v) => v.name === from)) {
				throw new actual.SuggestError('STEP_NOT_FOUND', `变量 "${from}" 不存在`)
			}
			if (flow.variables.some((v) => v.name === to)) {
				throw new actual.SuggestError('NAME_CONFLICT', `变量 "${to}" 已存在`)
			}
			const rewrite = (value: string) => value.split(`{{${from}}}`).join(`{{${to}}}`)
			const mapSteps = (steps: Step[]): Step[] =>
				steps.map((step) => {
					if (step.kind === 'group') return { ...step, steps: mapSteps(step.steps) }
					if (step.kind === 'input') return { ...step, value: rewrite(step.value) }
					if (step.kind === 'select' && typeof step.value === 'string') {
						return { ...step, value: rewrite(step.value) }
					}
					return step
				})
			return {
				...flow,
				steps: mapSteps(flow.steps),
				variables: flow.variables.map((v) => (v.name === from ? { ...v, name: to } : v)),
			}
		},
	}
})

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const { createStudioServer } = await import('./server.js')

function ref(testid: string, tag = 'input'): Record<string, unknown> {
	return {
		observed: {
			tag,
			attributes: { 'data-testid': testid },
			rect: { x: 10, y: 10, width: 200, height: 32 },
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: [{ kind: 'testid', value: testid, score: 1, source: 'record' }],
		fingerprint: {
			tag,
			attrs: { 'data-testid': testid },
			stableHash: `hash-${testid}`,
		},
		frame: { path: [] },
	}
}

function makeFlow(options: { id: string; steps: Step[]; variables?: unknown[] }): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: options.id,
		title: options.id,
		version: 1,
		createdAt: new Date().toISOString(),
		meta: {
			env: { startUrl: 'http://127.0.0.1:5173/basic', viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: 'test', version: '0' },
		},
		variables: options.variables ?? [],
		steps: options.steps,
		selfHealed: [],
	})
}

function basicFlow(): Flow {
	return makeFlow({
		id: 'basic-form',
		steps: [
			{ id: 'nav', kind: 'navigate', url: 'http://127.0.0.1:5173/basic' },
			{ id: 's1', kind: 'input', target: ref('field-full-name') as never, value: '张三', clear: true },
			{ id: 's2', kind: 'input', target: ref('field-email') as never, value: 'zhang@example.com', clear: true },
			{
				id: 's3',
				kind: 'select',
				target: ref('field-country', 'select') as never,
				value: 'cn',
			},
		],
	})
}

function templatedFlow(): Flow {
	return makeFlow({
		id: 'templated',
		variables: [{ name: 'email', type: 'string', secret: false, source: 'input' }],
		steps: [
			{ id: 'nav', kind: 'navigate', url: 'http://127.0.0.1:5173/basic' },
			{ id: 's1', kind: 'input', target: ref('field-email') as never, value: '{{email}}', clear: true },
		],
	})
}

function multiSelectFlow(): Flow {
	return makeFlow({
		id: 'multi-select',
		steps: [
			{ id: 'nav', kind: 'navigate', url: 'http://127.0.0.1:5173/custom-select' },
			{ id: 's1', kind: 'select', target: ref('multi', 'select') as never, value: ['cn', 'us'] },
		],
	})
}

/* ------------------------------------------------------------------ */
/* server helpers                                                      */
/* ------------------------------------------------------------------ */

interface Harness {
	base: string
	port: number
	flowsDir: string
	artifactsDir: string
	close: () => Promise<void>
}

let harness: Harness | undefined
const tempDirs: string[] = []

async function startHarness(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'rr-studio-api-'))
	tempDirs.push(root)
	const flowsDir = join(root, 'flows')
	const artifactsDir = join(root, 'artifacts')
	await (await import('node:fs/promises')).mkdir(flowsDir, { recursive: true })
	for (const flow of [basicFlow(), templatedFlow(), multiSelectFlow()]) {
		await writeFile(join(flowsDir, `${flow.id}.json`), serializeFlow(flow), 'utf8')
	}
	const server = await createStudioServer({ port: 0, flowsDir, artifactsDir })
	const started: Harness = {
		base: `http://127.0.0.1:${server.port}`,
		port: server.port,
		flowsDir,
		artifactsDir,
		close: server.close,
	}
	harness = started
	return started
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
	const response = await fetch(`${harness!.base}${pathname}`)
	return { status: response.status, body: await response.json() }
}

async function postJson(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
	const response = await fetch(`${harness!.base}${pathname}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	return { status: response.status, body: await response.json() }
}

async function readFlowFromDisk(id: string): Promise<Flow> {
	return loadFlow(join(harness!.flowsDir, `${id}.json`))
}

function bakPath(id: string): string {
	return join(harness!.flowsDir, `${id}.json.bak`)
}

beforeEach(async () => {
	h.calls.analyze.length = 0
	h.calls.applySuggestion.length = 0
	h.calls.applySuggestions.length = 0
	h.calls.renameVariable.length = 0
	await startHarness()
})

afterEach(async () => {
	if (harness) {
		await harness.close()
		harness = undefined
	}
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe('studio API: 隔离性（临时端口 + 临时目录）', () => {
	it('不要在 4400 上跑，且 flowsDir 指向临时目录', async () => {
		expect(harness!.port).not.toBe(4400)
		const config = await getJson('/api/config')
		expect(config.status).toBe(200)
		expect(config.body.flowsDir).toBe(harness!.flowsDir)
		expect(config.body.artifactsDir).toBe(harness!.artifactsDir)
		// 只能看到自己临时目录里的 3 条 flow
		const list = await getJson('/api/flows')
		expect(list.body.flows.map((f: { file: string }) => f.file).sort()).toEqual([
			'basic-form.json',
			'multi-select.json',
			'templated.json',
		])
	})
})

describe('studio API: GET suggestions', () => {
	it('默认不含 weak，flowVersion 与文件一致', async () => {
		const res = await getJson('/api/flows/basic-form.json/suggestions')
		expect(res.status).toBe(200)
		expect(res.body.flowVersion).toBe(1)
		expect(typeof res.body.generatedAt).toBe('string')
		expect(res.body.suggestions.map((s: { stepId: string }) => s.stepId)).toEqual(['s1', 's2', 's3'])
		expect(res.body.skipped.some((s: { stepId: string }) => s.stepId === 'nav')).toBe(true)
		expect(h.calls.analyze.at(-1)).toEqual({ flowVersion: 1, includeWeak: false })
	})

	it('includeWeak=1 会透传（多选 select 被跳过）', async () => {
		const res = await getJson('/api/flows/multi-select.json/suggestions?includeWeak=1')
		expect(res.status).toBe(200)
		expect(h.calls.analyze.at(-1)).toEqual({ flowVersion: 1, includeWeak: true })
		expect(res.body.skipped.some((s: { stepId: string }) => s.stepId === 's1')).toBe(true)
	})

	it('flow 不存在 → 404', async () => {
		const res = await getJson('/api/flows/nope.json/suggestions')
		expect(res.status).toBe(404)
		expect(res.body.error).toContain('不存在')
	})
})

describe('studio API: apply-suggestion（单条）', () => {
	it('成功：value 变模板、变量新增、version+1、.bak 落盘、文件仍通过 parseFlow', async () => {
		const before = await readFlowFromDisk('basic-form')
		const res = await postJson('/api/flows/basic-form.json/apply-suggestion', {
			stepId: 's1',
			name: 'full_name',
		})
		expect(res.status).toBe(200)
		expect(res.body.ok).toBe(true)
		expect(res.body.flow.version).toBe(before.version + 1)
		expect(res.body.steps).toHaveLength(4)
		expect(res.body.suggestions).not.toBeNull()
		expect(res.body.suggestions.flowVersion).toBe(before.version + 1)

		// 磁盘上的文件（loadFlow 内部会跑 parseFlow 契约校验）
		const after = await readFlowFromDisk('basic-form')
		expect(after.version).toBe(before.version + 1)
		expect(after.variables.map((v) => v.name)).toContain('full_name')
		expect((after.steps[1] as { value: string }).value).toBe('{{full_name}}')
		// .bak 是写入前的版本
		expect(existsSync(bakPath('basic-form'))).toBe(true)
		const bak = await loadFlow(bakPath('basic-form'))
		expect(bak.version).toBe(before.version)
		expect((bak.steps[1] as { value: string }).value).toBe('张三')
	})

	it('applySameValue：两处同值都替换，但 version 只 +1', async () => {
		const before = await readFlowFromDisk('basic-form')
		const res = await postJson('/api/flows/basic-form.json/apply-suggestion', {
			stepId: 's1',
			name: 'person_name',
			applySameValue: true,
		})
		expect(res.status).toBe(200)
		const after = await readFlowFromDisk('basic-form')
		expect(after.version).toBe(before.version + 1)
	})

	it('非法变量名 → 400 INVALID_NAME，且不落盘', async () => {
		const before = await readFile(join(harness!.flowsDir, 'basic-form.json'), 'utf8')
		const res = await postJson('/api/flows/basic-form.json/apply-suggestion', {
			stepId: 's1',
			name: '9-bad-name',
		})
		expect(res.status).toBe(400)
		expect(res.body.code).toBe('INVALID_NAME')
		expect(res.body.error).toContain('不合法')
		expect(existsSync(bakPath('basic-form'))).toBe(false)
		const after = await readFile(join(harness!.flowsDir, 'basic-form.json'), 'utf8')
		expect(after).toBe(before)
	})

	it('步骤不存在 → 400 STEP_NOT_FOUND', async () => {
		const res = await postJson('/api/flows/basic-form.json/apply-suggestion', {
			stepId: 'no-such-step',
			name: 'x',
		})
		expect(res.status).toBe(400)
		expect(res.body.code).toBe('STEP_NOT_FOUND')
	})

	it('参数缺失（没有 name）→ 400，且不调用 suggest', async () => {
		const calls = h.calls.applySuggestion.length
		const res = await postJson('/api/flows/basic-form.json/apply-suggestion', { stepId: 's1' })
		expect(res.status).toBe(400)
		expect(res.body.code).toBe('BAD_REQUEST')
		expect(res.body.error).toContain('name')
		expect(h.calls.applySuggestion.length).toBe(calls)
	})

	it('非法 type → 400', async () => {
		const res = await postJson('/api/flows/basic-form.json/apply-suggestion', {
			stepId: 's1',
			name: 'ok_name',
			type: 'boolean',
		})
		expect(res.status).toBe(400)
		expect(res.body.error).toContain('type')
	})

	it('flow 不存在 → 404', async () => {
		const res = await postJson('/api/flows/nope.json/apply-suggestion', { stepId: 's1', name: 'x' })
		expect(res.status).toBe(404)
	})
})

describe('studio API: apply-suggestions（批量，先校验后落盘）', () => {
	it('全部合法：多条一起应用，version 只 +1', async () => {
		const before = await readFlowFromDisk('basic-form')
		const res = await postJson('/api/flows/basic-form.json/apply-suggestions', {
			apply: [
				{ stepId: 's1', name: 'full_name' },
				{ stepId: 's2', name: 'email', type: 'email' },
			],
		})
		expect(res.status).toBe(200)
		expect(res.body.ok).toBe(true)
		const after = await readFlowFromDisk('basic-form')
		expect(after.version).toBe(before.version + 1) // 关键：不是 +2
		expect(after.variables.map((v) => v.name).sort()).toEqual(['email', 'full_name'])
		expect((after.steps[1] as { value: string }).value).toBe('{{full_name}}')
		expect((after.steps[2] as { value: string }).value).toBe('{{email}}')
		expect(existsSync(bakPath('basic-form'))).toBe(true)
	})

	it('任一条非法 → 400 且整体不落盘（无 .bak、文件字节不变）', async () => {
		const file = join(harness!.flowsDir, 'basic-form.json')
		const before = await readFile(file, 'utf8')
		const res = await postJson('/api/flows/basic-form.json/apply-suggestions', {
			apply: [
				{ stepId: 's1', name: 'full_name' },
				{ stepId: 's2', name: '2-bad' },
			],
		})
		expect(res.status).toBe(400)
		expect(res.body.code).toBe('INVALID_NAME')
		expect(existsSync(bakPath('basic-form'))).toBe(false)
		expect(await readFile(file, 'utf8')).toBe(before)
	})

	it('批量参数错（apply 不是数组 / 空数组）→ 400', async () => {
		const notArray = await postJson('/api/flows/basic-form.json/apply-suggestions', { apply: 'x' })
		expect(notArray.status).toBe(400)
		expect(notArray.body.error).toContain('apply')
		const empty = await postJson('/api/flows/basic-form.json/apply-suggestions', { apply: [] })
		expect(empty.status).toBe(400)
	})

	it('批量里某条缺字段 → 400 且错误信息带序号', async () => {
		const res = await postJson('/api/flows/basic-form.json/apply-suggestions', {
			apply: [{ stepId: 's1', name: 'full_name' }, { stepId: 's2' }],
		})
		expect(res.status).toBe(400)
		expect(res.body.error).toContain('第 2 条')
	})
})

describe('studio API: variables/rename', () => {
	it('成功：变量定义与所有模板一起改名，version+1，.bak 存在', async () => {
		const before = await readFlowFromDisk('templated')
		const res = await postJson('/api/flows/templated.json/variables/rename', {
			from: 'email',
			to: 'mail',
		})
		expect(res.status).toBe(200)
		expect(res.body.ok).toBe(true)
		const after = await readFlowFromDisk('templated')
		expect(after.version).toBe(before.version + 1)
		expect(after.variables.map((v) => v.name)).toEqual(['mail'])
		expect((after.steps[1] as { value: string }).value).toBe('{{mail}}')
		expect(existsSync(bakPath('templated'))).toBe(true)
	})

	it('变量不存在 → 400 STEP_NOT_FOUND', async () => {
		const res = await postJson('/api/flows/templated.json/variables/rename', {
			from: 'nope',
			to: 'x',
		})
		expect(res.status).toBe(400)
		expect(res.body.code).toBe('STEP_NOT_FOUND')
	})

	it('同名 → 400（不调用重命名）', async () => {
		const calls = h.calls.renameVariable.length
		const res = await postJson('/api/flows/templated.json/variables/rename', {
			from: 'email',
			to: 'email',
		})
		expect(res.status).toBe(400)
		expect(res.body.error).toContain('相同')
		expect(h.calls.renameVariable.length).toBe(calls)
	})

	it('非法新名 / 缺字段 → 400', async () => {
		const badName = await postJson('/api/flows/templated.json/variables/rename', {
			from: 'email',
			to: '1bad',
		})
		expect(badName.status).toBe(400)
		expect(badName.body.code).toBe('INVALID_NAME')
		const missing = await postJson('/api/flows/templated.json/variables/rename', { from: 'email' })
		expect(missing.status).toBe(400)
		expect(missing.body.code).toBe('BAD_REQUEST')
	})

	it('flow 不存在 → 404', async () => {
		const res = await postJson('/api/flows/nope.json/variables/rename', { from: 'a', to: 'b' })
		expect(res.status).toBe(404)
	})
})

describe('studio API: 已有路由不受影响', () => {
	it('GET /api/flows/:file 仍返回 flow + steps', async () => {
		const res = await getJson('/api/flows/basic-form.json')
		expect(res.status).toBe(200)
		expect(res.body.flow.id).toBe('basic-form')
		expect(res.body.steps).toHaveLength(4)
	})
})

// 供其它用例复用（避免 noUnusedLocals）
void SuggestError
