/**
 * 跨包一致性回归：resolver 的 computeStableHash 必须与 recorder 的 stableHashOf 逐字节一致。
 *
 * 为什么要有这个测试：resolver 不能反向依赖 recorder（依赖方向约束），算法是**复刻**的；
 * 任何一边改 payload/属性策略，这里立刻红，避免「录制出来的 flow 回放时 L2 全部降级成 attrs」这种
 * 静默退化。将来若把该函数上移到 @rr/schema，这个测试可以退役。
 */
import { stableHashOf, pickFingerprintAttrs } from '@rr/recorder'
import { describe, expect, it } from 'vitest'

import { computeStableHash, stableAttrsOf } from '@rr/resolver'

const cases: Array<{
	name: string
	input: Parameters<typeof stableHashOf>[0]
}> = [
	{
		name: '带 testid 的 input',
		input: {
			tag: 'input',
			role: 'textbox',
			accessibleName: '姓名',
			attrs: { id: 'full-name', name: 'fullName', type: 'text', 'data-testid': 'field-full-name' },
			nodePath: [1, 2, 3],
		},
	},
	{
		name: '无属性按钮',
		input: { tag: 'button', role: 'button', accessibleName: '提交', attrs: {}, nodePath: [1, 4] },
	},
	{
		name: '无 nodePath（老 flow）',
		input: { tag: 'a', role: 'link', accessibleName: '返回', attrs: { href: '/back' } },
	},
	{
		name: '中文属性值 + 多属性排序',
		input: {
			tag: 'select',
			role: 'combobox',
			accessibleName: '国家',
			attrs: { name: 'country', id: 'country', 'data-testid': 'field-country' },
			nodePath: [1, 2, 0, 5],
		},
	},
]

describe('resolver ⇄ recorder：stableHash 跨包一致', () => {
	for (const testCase of cases) {
		it(`hash 一致：${testCase.name}`, () => {
			const recorderHash = stableHashOf(testCase.input)
			const resolverHash = computeStableHash({
				tag: testCase.input.tag,
				...(testCase.input.role !== undefined ? { role: testCase.input.role } : {}),
				...(testCase.input.accessibleName !== undefined
					? { accessibleName: testCase.input.accessibleName }
					: {}),
				attrs: testCase.input.attrs,
				...(testCase.input.nodePath !== undefined ? { nodePath: testCase.input.nodePath } : {}),
			})
			expect(resolverHash).toBe(recorderHash)
		})
	}

	it('属性过滤策略一致：同一组原始属性 → 同一份稳定属性表', () => {
		const raw: Record<string, string> = {
			id: 'submit-basic',
			class: 'dyn-x9f2k1',
			style: 'color:red',
			value: 'typed text',
			checked: '',
			'aria-label': '提交表单',
			'data-testid': 'submit-basic',
			'data-rr-uid': 'e12',
			placeholder: '请输入',
			type: 'submit',
			name: 'submit',
			'aria-expanded': 'false',
		}
		expect(stableAttrsOf(raw)).toEqual(pickFingerprintAttrs(raw))
	})
})
