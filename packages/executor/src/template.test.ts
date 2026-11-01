import { describe, expect, it } from 'vitest'

import { defaultVariables, renderStep, TemplateError } from './index.js'
import { makeRef } from './testUtils.js'

const ref = makeRef()

describe('executor: 变量替换', () => {
	it('defaultVariables 只取有 defaultValue 的变量', () => {
		expect(
			defaultVariables([
				{ name: 'a', defaultValue: '1' },
				{ name: 'b' },
				{ name: 'c', defaultValue: '3' },
			]),
		).toEqual({ a: '1', c: '3' })
	})

	it('input.value 渲染模板', () => {
		const rendered = renderStep(
			{
				id: 'fill',
				kind: 'input',
				target: ref,
				value: 'hello {{name}}',
				clear: true,
			},
			{ name: '世界' },
		)
		expect(rendered.kind).toBe('input')
		if (rendered.kind === 'input') expect(rendered.value).toBe('hello 世界')
	})

	it('缺变量 → TemplateError，且带变量名（绝不留空串）', () => {
		try {
			renderStep(
				{ id: 'fill', kind: 'input', target: ref, value: '{{email}}', clear: true },
				{},
			)
			throw new Error('应当抛错')
		} catch (err) {
			expect(err).toBeInstanceOf(TemplateError)
			expect((err as TemplateError).variable).toBe('email')
			expect((err as TemplateError).message).toContain('email')
		}
	})

	it('navigate.url / key.key / upload.files / select 数组都渲染', () => {
		const nav = renderStep(
			{ id: 'nav', kind: 'navigate', url: 'https://x.test/{{path}}' },
			{ path: 'basic' },
		)
		expect(nav.kind === 'navigate' && nav.url).toBe('https://x.test/basic')

		const key = renderStep({ id: 'k', kind: 'key', key: '{{k}}' }, { k: 'Enter' })
		expect(key.kind === 'key' && key.key).toBe('Enter')

		const upload = renderStep(
			{ id: 'u', kind: 'upload', target: ref, files: ['/tmp/{{f}}.png'] },
			{ f: 'a' },
		)
		expect(upload.kind === 'upload' && upload.files).toEqual(['/tmp/a.png'])

		const select = renderStep(
			{
				id: 's',
				kind: 'select',
				target: ref,
				value: ['{{a}}', '{{b}}'],
			},
			{ a: 'cn', b: 'us' },
		)
		expect(select.kind === 'select' && select.value).toEqual(['cn', 'us'])
	})

	it('group 递归渲染子步骤', () => {
		const rendered = renderStep(
			{
				id: 'g',
				kind: 'group',
				label: '分组',
				steps: [{ id: 'inner', kind: 'input', target: ref, value: '{{v}}', clear: true }],
			},
			{ v: 'x' },
		)
		expect(rendered.kind).toBe('group')
		if (rendered.kind === 'group') {
			const inner = rendered.steps[0]
			expect(inner && inner.kind === 'input' ? inner.value : '').toBe('x')
		}
	})

	it('expect.urlChange.pattern 也渲染', () => {
		const rendered = renderStep(
			{
				id: 'nav',
				kind: 'navigate',
				url: 'https://x.test/{{path}}',
				expect: { kind: 'urlChange', pattern: '**/{{path}}' },
			},
			{ path: 'done' },
		)
		expect(rendered.expect?.kind === 'urlChange' ? rendered.expect.pattern : '').toBe('**/done')
	})

	it('不修改入参（不可变）', () => {
		const step = { id: 'fill', kind: 'input', target: ref, value: '{{v}}', clear: true } as const
		const copy = structuredClone(step)
		renderStep(step, { v: 'x' })
		expect(step).toEqual(copy)
	})

	it('没有模板的字符串原样保留', () => {
		const rendered = renderStep(
			{ id: 'fill', kind: 'input', target: ref, value: 'plain text', clear: true },
			{},
		)
		expect(rendered.kind === 'input' && rendered.value).toBe('plain text')
	})
})
