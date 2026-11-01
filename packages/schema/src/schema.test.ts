import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
	FlowValidationError,
	loadFlow,
	makeId,
	parseFlow,
	parseTemplate,
	resolveTemplate,
	saveFlow,
	type ElementRef,
	type Flow,
} from './index.js'

function ref(overrides: Partial<ElementRef> = {}): ElementRef {
	return {
		observed: {
			tag: 'button',
			attributes: { type: 'submit' },
			text: '提交',
			rect: { x: 10, y: 20, width: 80, height: 32 },
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: [
			{ kind: 'testid', value: 'submit-btn', score: 2, source: 'record' },
			{ kind: 'role', value: { role: 'button', name: '提交' }, score: 100, source: 'record' },
		],
		fingerprint: {
			tag: 'button',
			role: 'button',
			accessibleName: '提交',
			attrs: { type: 'submit' },
			stableHash: 'abc123',
			nodePath: [1, 2, 0],
		},
		frame: { path: [] },
		description: '表单底部右侧的蓝色提交按钮',
		nearbyText: ['邮箱', '密码'],
		crop: { ref: 'elements/0/element.png', dpr: 2 },
		...overrides,
	}
}

function flow(overrides: Partial<Flow> = {}): Flow {
	return {
		schemaVersion: 1,
		id: 'flow_1',
		title: '登录后提交表单',
		version: 1,
		createdAt: new Date(0).toISOString(),
		meta: {
			env: {
				startUrl: 'http://127.0.0.1:5173/basic',
				viewport: { width: 1440, height: 900 },
				dpr: 2,
			},
			recorder: { name: '@rr/recorder', version: '0.0.1' },
		},
		variables: [],
		steps: [
			{ kind: 'navigate', id: 's1', url: 'http://127.0.0.1:5173/basic' },
			{ kind: 'click', id: 's2', target: ref(), button: 'left', clickCount: 1, modifiers: [] },
		],
		selfHealed: [],
		...overrides,
	}
}

const dirs: string[] = []
async function tmp(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), 'rr-schema-'))
	dirs.push(d)
	return d
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('schema: 基础', () => {
	it('最小 flow 可通过校验', () => {
		const parsed = parseFlow(flow())
		expect(parsed.steps).toHaveLength(2)
		expect(parsed.steps[1]).toMatchObject({ kind: 'click', button: 'left' })
	})

	it('生成稳定 id 且不重复', () => {
		const ids = new Set(Array.from({ length: 50 }, () => makeId('flow')))
		expect(ids.size).toBe(50)
	})

	it('steps 为空时拒绝', () => {
		expect(() => parseFlow(flow({ steps: [] }))).toThrow(FlowValidationError)
	})

	it('group 步骤递归解析', () => {
		const parsed = parseFlow(
			flow({
				steps: [
					{
						kind: 'group',
						id: 'g1',
						label: '提交表单',
						steps: [
							{
								kind: 'click',
								id: 'c1',
								target: ref(),
								button: 'left',
								clickCount: 1,
								modifiers: [],
							},
						],
					},
				],
			}),
		)
		expect(parsed.steps[0]).toMatchObject({ kind: 'group' })
	})
})

describe('schema: 跨字段契约', () => {
	it('candidates 未按 score 升序时拒绝', () => {
		const bad = ref({
			candidates: [
				{ kind: 'role', value: { role: 'button', name: '提交' }, score: 100, source: 'record' },
				{ kind: 'testid', value: 'submit-btn', score: 2, source: 'record' },
			],
		})
		expect(() =>
			parseFlow(
				flow({
					steps: [
						{ kind: 'click', id: 's', target: bad, button: 'left', clickCount: 1, modifiers: [] },
					],
				}),
			),
		).toThrow(/score 升序/)
	})

	it('crop.ref 必须是安全相对路径', () => {
		const bad = ref({ crop: { ref: '../../etc/passwd', dpr: 1 } })
		expect(() =>
			parseFlow(
				flow({
					steps: [
						{ kind: 'click', id: 's', target: bad, button: 'left', clickCount: 1, modifiers: [] },
					],
				}),
			),
		).toThrow(/相对路径/)
	})

	it('password 输入落明文时拒绝', () => {
		const pwdRef = ref()
		pwdRef.observed.attributes = { type: 'password' }
		expect(() =>
			parseFlow(
				flow({
					steps: [{ kind: 'input', id: 's', target: pwdRef, value: 'hunter2', clear: true }],
				}),
			),
		).toThrow(/password/)
	})

	it('password 输入用模板时通过', () => {
		const pwdRef = ref()
		pwdRef.observed.attributes = { type: 'password' }
		const parsed = parseFlow(
			flow({ steps: [{ kind: 'input', id: 's', target: pwdRef, value: '{{pwd}}', clear: true }] }),
		)
		expect(parsed.steps[0]).toMatchObject({ kind: 'input', value: '{{pwd}}' })
	})
})

describe('schema: 模板', () => {
	it('提取模板变量', () => {
		expect(parseTemplate('hello {{name}} {{ age }}')).toEqual(['name', 'age'])
		expect(parseTemplate('no template')).toEqual([])
	})

	it('未闭合模板报错', () => {
		expect(() => parseTemplate('hello {{name')).toThrow(/模板语法错误/)
		expect(() => parseTemplate('}} hello {{name}}')).toThrow(/模板语法错误/)
		expect(() => parseTemplate('a {{b}} c')).not.toThrow()
	})

	it('缺失变量时显式失败而不是填空串', () => {
		expect(resolveTemplate('{{a}}-{{b}}', { a: '1', b: '2' })).toBe('1-2')
		expect(() => resolveTemplate('{{missing}}', {})).toThrow(/缺少变量/)
	})
})

describe('schema: 迁移', () => {
	it('v0（无 schemaVersion）自动升级到 v1', () => {
		const legacy = JSON.parse(JSON.stringify(flow())) as Record<string, unknown>
		delete legacy.schemaVersion
		delete legacy.selfHealed
		const parsed = parseFlow(legacy)
		expect(parsed.schemaVersion).toBe(1)
		expect(parsed.selfHealed).toEqual([])
	})

	it('更高版本给出明确升级提示', () => {
		const future = { ...flow(), schemaVersion: 2 }
		expect(() => parseFlow(future)).toThrow(/请升级 rr/)
	})
})

describe('schema: 读写', () => {
	it('roundtrip 保存后可读回', async () => {
		const d = await tmp()
		const file = join(d, 'flow.json')
		await saveFlow(flow(), file)
		const loaded = await loadFlow(file)
		expect(loaded.id).toBe('flow_1')
		expect(loaded.meta.env.startUrl).toContain('/basic')
		const raw = await readFile(file, 'utf8')
		expect(raw.endsWith('\n')).toBe(true)
	})

	it('不留下 .tmp 临时文件', async () => {
		const d = await tmp()
		const file = join(d, 'f.json')
		await saveFlow(flow(), file)
		expect(await readdir(d)).toEqual(['f.json'])
	})

	it('backup=true 时保留旧文件', async () => {
		const d = await tmp()
		const file = join(d, 'f.json')
		await saveFlow(flow({ title: 'v1' }), file)
		await saveFlow(flow({ title: 'v2', version: 2 }), file, { backup: true })
		expect(await readdir(d)).toEqual(['f.json', 'f.json.bak'])
		const bak = JSON.parse(await readFile(`${file}.bak`, 'utf8')) as Flow
		expect(bak.title).toBe('v1')
	})

	it('非法 flow 不会落盘', async () => {
		const d = await tmp()
		const file = join(d, 'f.json')
		await expect(saveFlow(flow({ steps: [] }), file)).rejects.toThrow(FlowValidationError)
		await expect(readdir(d)).resolves.toEqual([])
	})

	it('JSON 损坏时报可读错误', async () => {
		const d = await tmp()
		const file = join(d, 'bad.json')
		await writeFile(file, '{ not json', 'utf8')
		await expect(loadFlow(file)).rejects.toThrow(/无法解析 flow/)
	})
})
