import { describe, expect, it } from 'vitest'

import {
	canonicalHashInput,
	computeHashFromFingerprint,
	computeStableHash,
	isDynamicValue,
	isStableAttr,
	normalizeText,
	stableAttrsOf,
} from './index.js'

describe('resolver: 指纹属性策略（与 recorder/pickFingerprintAttrs 一致）', () => {
	it('剔除动态/易变属性：class / style / value / checked / aria-expanded', () => {
		const attrs = stableAttrsOf({
			id: 'submit-basic',
			class: 'dyn-abc123',
			style: 'color: red',
			value: 'hello',
			checked: '',
			'aria-expanded': 'true',
			'aria-label': '提交',
			type: 'submit',
		})
		expect(attrs).toEqual({ id: 'submit-basic', 'aria-label': '提交', type: 'submit' })
	})

	it('保留白名单属性与 data- 前缀', () => {
		const attrs = stableAttrsOf({
			'data-testid': 'field-email',
			'data-cy': 'email',
			'aria-describedby': 'hint',
			placeholder: 'name@example.com',
		})
		expect(attrs).toEqual({
			'data-testid': 'field-email',
			'data-cy': 'email',
			'aria-describedby': 'hint',
			placeholder: 'name@example.com',
		})
	})

	it('剔除自身标记 data-rr-*（否则 L2 会把自己算进指纹）', () => {
		expect(isStableAttr('data-rr-target')).toBe(false)
		expect(stableAttrsOf({ 'data-rr-target': 'rr1', id: 'x' })).toEqual({ id: 'x' })
	})

	it('剔除看起来是动态值的属性值（uuid / 长 hex / 4+ 连续数字）', () => {
		expect(isDynamicValue('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true)
		expect(isDynamicValue('deadbeefdeadbeef')).toBe(true)
		expect(isDynamicValue('field-1234')).toBe(true)
		expect(isDynamicValue('submit-basic')).toBe(false)
		expect(
			stableAttrsOf({ id: 'field-123456', name: 'fullName', 'data-x': 'uuid-9f8e7d6c-1111-2222-3333-444455556666' }),
		).toEqual({ name: 'fullName' })
	})

	it('空字符串属性被丢掉；属性值保持原样（不做空白归一化，否则 hash 与录制侧对不上）', () => {
		// 注意：'  ' 在 recorder 的 pickFingerprintAttrs 里也属于"非空"，会保留 —— 必须一致
		expect(stableAttrsOf({ id: '', title: '  a\n b  ', name: 'q' })).toEqual({
			name: 'q',
			title: '  a\n b  ',
		})
		expect(stableAttrsOf({ id: '  ' })).toEqual({ id: '  ' })
	})

	it('未知属性不进入指纹', () => {
		expect(isStableAttr('foo')).toBe(false)
		expect(isStableAttr('ID')).toBe(true) // 大小写不敏感
	})
})

describe('resolver: stableHash（与 recorder 同算法）', () => {
	it('确定性：同样输入永远同样 hash，且是 40 位 hex', () => {
		const input = { tag: 'button', role: 'button', accessibleName: '提交', attrs: { id: 'a' } }
		expect(computeStableHash(input)).toBe(computeStableHash(input))
		expect(computeStableHash(input)).toMatch(/^[0-9a-f]{40}$/)
	})

	it('payload 与 recorder 完全一致（\\u0000 分隔 + 属性字典序 + nodePath 末位）', () => {
		expect(
			canonicalHashInput({ tag: 'a', attrs: { id: 'q', name: 'n' }, nodePath: [1, 2] }),
		).toBe(['a', '', '', 'id=q&name=n', '1.2'].join('\u0000'))
		expect(canonicalHashInput({ tag: 'a', attrs: {} })).toBe(['a', '', '', '', ''].join('\u0000'))
	})

	it('可访问名变化 → hash 变化', () => {
		const base = { tag: 'button', role: 'button', attrs: {} }
		expect(computeStableHash({ ...base, accessibleName: '提交' })).not.toBe(
			computeStableHash({ ...base, accessibleName: '重置' }),
		)
	})

	it('属性顺序不影响结果（内部按 key 排序）', () => {
		const a = computeStableHash({ tag: 'input', attrs: { id: 'x', name: 'y' } })
		const b = computeStableHash({ tag: 'input', attrs: { name: 'y', id: 'x' } })
		expect(a).toBe(b)
	})

	it('nodePath 参与 hash：两个一模一样的按钮可以区分', () => {
		const base = { tag: 'button', role: 'button', accessibleName: '提交', attrs: { type: 'button' } }
		const first = computeStableHash({ ...base, nodePath: [1, 2, 0] })
		const second = computeStableHash({ ...base, nodePath: [1, 2, 1] })
		expect(first).not.toBe(second)
	})

	it('动态 class 不改变 hash（fixture /basic 的 volatile-class 场景）', () => {
		const before = computeStableHash({
			tag: 'button',
			role: 'button',
			accessibleName: '动态 class 按钮',
			attrs: { id: 'volatile-class-btn', 'data-testid': 'volatile-class' },
		})
		const afterDynamicClass = computeStableHash({
			tag: 'button',
			role: 'button',
			accessibleName: '动态 class 按钮',
			attrs: stableAttrsOf({
				id: 'volatile-class-btn',
				class: 'dyn-x9f2k1',
				'data-testid': 'volatile-class',
			}),
		})
		expect(afterDynamicClass).toBe(before)
	})

	it('computeHashFromFingerprint 带 nodePath 时与直接算一致', () => {
		const fingerprint = {
			tag: 'input',
			role: 'textbox',
			accessibleName: '姓名',
			attrs: { id: 'full-name', name: 'fullName' },
			stableHash: '',
			nodePath: [1, 2, 0],
		}
		expect(computeHashFromFingerprint(fingerprint)).toBe(
			computeStableHash({
				tag: 'input',
				role: 'textbox',
				accessibleName: '姓名',
				attrs: { id: 'full-name', name: 'fullName' },
				nodePath: [1, 2, 0],
			}),
		)
	})

	it('normalizeText 折叠空白（只用于名字/文本比较）', () => {
		expect(normalizeText('  a \n\t b ')).toBe('a b')
		expect(normalizeText(undefined)).toBe('')
	})
})
