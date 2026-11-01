/**
 * buildElementRef 单测：产物必须是**合法 IR**（能被 `parseFlow` 接受），
 * 且候选按 score 升序、指纹剔除动态属性、stableHash 稳定。
 */
import { describe, expect, it } from 'vitest'

import { parseFlow, SCHEMA_VERSION } from '@rr/schema'
import type { Flow } from '@rr/schema'

import {
	buildElementRef,
	deriveCandidates,
	isDynamicValue,
	pickFingerprintAttrs,
	sortCandidates,
	stableHashOf,
	xpathFromNodePath,
} from './element.js'
import type { RawElementFacts } from './types.js'

function facts(overrides: Partial<RawElementFacts> = {}): RawElementFacts {
	return {
		tag: 'button',
		attributes: { 'data-testid': 'submit-basic', type: 'submit' },
		text: '提交表单',
		rect: { x: 100, y: 200, width: 120, height: 36 },
		scroll: { x: 0, y: 40 },
		viewport: { width: 1440, height: 900 },
		dpr: 1,
		recordedAt: 1_700_000_000_000,
		nodePath: [0, 2, 1],
		...overrides,
	}
}

function flowWith(elementRef: ReturnType<typeof buildElementRef>, index = 0): Flow {
	return {
		schemaVersion: SCHEMA_VERSION,
		id: 'flow_test',
		title: 'test',
		version: 1,
		createdAt: new Date(1_700_000_000_000).toISOString(),
		meta: {
			env: { startUrl: 'http://127.0.0.1:5173/basic', viewport: { width: 1440, height: 900 }, dpr: 1 },
			recorder: { name: '@rr/recorder', version: '0.1.0' },
		},
		variables: [],
		steps: [{ kind: 'click', id: `s${index + 1}`, target: elementRef, button: 'left', clickCount: 1, modifiers: [] }],
		selfHealed: [],
	}
}

describe('buildElementRef', () => {
	it('产出合法 ElementRef，且能通过 parseFlow（含契约校验）', () => {
		const ref = buildElementRef(facts())
		// 必填字段齐备
		expect(ref.observed.tag).toBe('button')
		expect(ref.observed.rect).toEqual({ x: 100, y: 200, width: 120, height: 36 })
		expect(ref.fingerprint.stableHash).toMatch(/^[0-9a-f]{40}$/)
		expect(ref.candidates.length).toBeGreaterThan(0)
		// 走真实 IR 校验链路（candidates 升序 / crop 安全路径 / 密码模板都在这里检查）
		expect(() => parseFlow(flowWith(ref))).not.toThrow()
	})

	it('candidates 按 score 升序（schema 契约硬要求）', () => {
		const ref = buildElementRef(facts())
		const scores = ref.candidates.map((c) => c.score)
		expect(scores).toEqual([...scores].sort((a, b) => a - b))
	})

	it('testid 候选排第一', () => {
		const ref = buildElementRef(facts())
		expect(ref.candidates[0]).toMatchObject({ kind: 'testid', value: 'submit-basic', source: 'record' })
	})

	it('有 role + accessibleName 时生成 role 候选（精确在前、模糊在后）', () => {
		const ref = buildElementRef(
			facts({ role: 'button', accessibleName: '提交表单', attributes: { type: 'submit' } }),
		)
		const roleCandidates = ref.candidates.filter((c) => c.kind === 'role')
		expect(roleCandidates.length).toBe(2)
		expect(roleCandidates[0]).toMatchObject({ value: { role: 'button', name: '提交表单', exact: true } })
		expect(roleCandidates[1]).toMatchObject({ value: { role: 'button', name: '提交表单', exact: false } })
	})

	it('label 候选来自关联标签', () => {
		const ref = buildElementRef(facts({ tag: 'input', attributes: { type: 'text' }, labels: ['姓名'] }))
		expect(ref.candidates.some((c) => c.kind === 'label' && c.value === '姓名')).toBe(true)
	})

	it('输入框不用可见文本当候选（避免 placeholder/value 混淆）', () => {
		const ref = buildElementRef(facts({ tag: 'input', attributes: { type: 'text' }, text: 'alice' }))
		expect(ref.candidates.some((c) => c.kind === 'text')).toBe(false)
	})

	it('稳定 id 生成 #id 候选；动态 id 不生成', () => {
		const stable = buildElementRef(facts({ attributes: { id: 'submit-basic' } }))
		expect(stable.candidates.some((c) => c.kind === 'css' && c.value === '#submit-basic')).toBe(true)
		const dynamic = buildElementRef(facts({ attributes: { id: 'el-1712345678901' } }))
		expect(dynamic.candidates.some((c) => c.kind === 'css' && String(c.value).startsWith('#'))).toBe(false)
	})

	it('总是有 nodePath 派生的 xpath 兜底', () => {
		const ref = buildElementRef(facts({ attributes: {}, text: undefined }))
		const xpath = ref.candidates.find((c) => c.kind === 'xpath')
		expect(xpath?.value).toBe('/html/*[1]/*[3]/*[2]')
	})

	it('指纹只留稳定属性（剔除 class/style/动态值）', () => {
		const ref = buildElementRef(
			facts({
				attributes: {
					id: 'submit-basic',
					class: 'btn primary',
					style: 'color: red',
					'data-testid': 'submit-basic',
					'data-row-key': 'row-1712345678901',
					'data-role-name': 'submit',
				},
			}),
		)
		expect(ref.fingerprint.attrs['class']).toBeUndefined()
		expect(ref.fingerprint.attrs['style']).toBeUndefined()
		expect(ref.fingerprint.attrs['data-row-key']).toBeUndefined()
		expect(ref.fingerprint.attrs['data-role-name']).toBe('submit')
		expect(ref.fingerprint.attrs['id']).toBe('submit-basic')
	})

	it('同样的输入 → 同样的 stableHash；属性变化 → hash 变化', () => {
		const a = buildElementRef(facts())
		const b = buildElementRef(facts())
		expect(a.fingerprint.stableHash).toBe(b.fingerprint.stableHash)
		const c = buildElementRef(facts({ attributes: { 'data-testid': 'other' } }))
		expect(c.fingerprint.stableHash).not.toBe(a.fingerprint.stableHash)
	})

	it('crop / frame 原样带进 IR（并在 parseFlow 里过路径安全校验）', () => {
		const ref = buildElementRef(
			facts({ crop: { ref: 'record/elements/3.png', dpr: 1 }, frame: { path: [] } }),
		)
		expect(ref.crop).toEqual({ ref: 'record/elements/3.png', dpr: 1 })
		expect(() => parseFlow(flowWith(ref))).not.toThrow()
	})

	it('不合法的 crop 路径会被契约拦下（证明校验真的生效）', () => {
		const ref = buildElementRef(facts({ crop: { ref: '../escape.png', dpr: 1 } }))
		expect(() => parseFlow(flowWith(ref))).toThrow(/crop\.ref/)
	})

	it('closed shadow 事实会带进 observed.shadowRootType / innerOffset', () => {
		const ref = buildElementRef(
			facts({ shadowRootType: 'closed', innerOffset: { x: 68, y: 144.3 } }),
		)
		expect(ref.observed.shadowRootType).toBe('closed')
		expect(ref.observed.innerOffset).toEqual({ x: 68, y: 144.3 })
	})

	it('closed shadow 的 click 不带 position → 被契约拒绝', () => {
		const ref = buildElementRef(facts({ shadowRootType: 'closed', innerOffset: { x: 1, y: 2 } }))
		expect(() => parseFlow(flowWith(ref))).toThrow(/closed shadow 目标必须带 position/)
	})

	it('closed shadow 的 click 带 position → 通过校验（Host + 偏移是回放唯一路径）', () => {
		const ref = buildElementRef(facts({ shadowRootType: 'closed', innerOffset: { x: 68, y: 144.3 } }))
		const flow = flowWith(ref)
		const step = flow.steps[0]
		if (!step || step.kind !== 'click') throw new Error('unexpected step')
		step.position = { x: 68, y: 144.3 }
		expect(() => parseFlow(flow)).not.toThrow()
	})

	it('description 里带 tag / testid / 角色信息', () => {
		const ref = buildElementRef(facts({ role: 'button', accessibleName: '提交表单' }))
		expect(ref.description).toContain('button')
		expect(ref.description).toContain('testid=submit-basic')
		expect(ref.description).toContain('role=button')
	})

	it('观测事实里的 scroll / viewport / dpr 原样保留', () => {
		const ref = buildElementRef(facts())
		expect(ref.observed.scroll).toEqual({ x: 0, y: 40 })
		expect(ref.observed.viewport).toEqual({ width: 1440, height: 900 })
		expect(ref.observed.dpr).toBe(1)
		expect(ref.observed.recordedAt).toBe(1_700_000_000_000)
	})
})

describe('候选工具', () => {
	it('sortCandidates 同分时保持插入顺序（稳定排序）', () => {
		const sorted = sortCandidates([
			{ kind: 'css', value: '#b', score: 100, source: 'record' },
			{ kind: 'css', value: '#a', score: 100, source: 'record' },
			{ kind: 'testid', value: 'x', score: 10, source: 'record' },
		])
		expect(sorted.map((c) => c.value)).toEqual(['x', '#b', '#a'])
	})

	it('deriveCandidates 去重（同 kind+value 只留一次）', () => {
		const list = deriveCandidates(
			facts({ attributes: { 'data-testid': 'x', name: 'x', placeholder: 'x' } }),
		)
		const keys = list.map((c) => `${c.kind}:${JSON.stringify(c.value)}`)
		expect(new Set(keys).size).toBe(keys.length)
	})

	it('isDynamicValue 识别 uuid / 长数字 / 长 hex', () => {
		expect(isDynamicValue('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
		expect(isDynamicValue('1712345678901')).toBe(true)
		expect(isDynamicValue('deadbeefdeadbeefdeadbeef')).toBe(true)
		expect(isDynamicValue('submit-basic')).toBe(false)
	})

	it('pickFingerprintAttrs 跳过空值', () => {
		expect(pickFingerprintAttrs({ id: '', name: 'ok' })).toEqual({ name: 'ok' })
	})

	it('stableHashOf 与属性顺序无关', () => {
		const a = stableHashOf({ tag: 'button', attrs: { id: 'a', name: 'b' } })
		const b = stableHashOf({ tag: 'button', attrs: { name: 'b', id: 'a' } })
		expect(a).toBe(b)
	})

	it('xpathFromNodePath 产出 1-based 索引', () => {
		expect(xpathFromNodePath([0, 2])).toBe('/html/*[1]/*[3]')
		expect(xpathFromNodePath([])).toBeUndefined()
		expect(xpathFromNodePath(undefined)).toBeUndefined()
	})
})
