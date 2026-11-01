import { describe, expect, it } from 'vitest'

import { buildKeyChord, describeKeyChord } from './index.js'

describe('executor: 组合键拼接', () => {
	it('无修饰键 → 原样返回（兼容老 flow）', () => {
		expect(buildKeyChord('Enter')).toBe('Enter')
		expect(buildKeyChord('Tab')).toBe('Tab')
		expect(buildKeyChord('a')).toBe('a')
		expect(buildKeyChord('Enter', [])).toBe('Enter')
		expect(buildKeyChord('Enter', null)).toBe('Enter')
	})

	it('单个修饰键 → Control+A', () => {
		expect(buildKeyChord('a', ['Control'])).toBe('Control+a')
		expect(buildKeyChord('A', ['Control'])).toBe('Control+A')
		expect(buildKeyChord('v', ['Meta'])).toBe('Meta+v')
	})

	it('多个修饰键按固定顺序排列（Control > Alt > Shift > Meta）', () => {
		expect(buildKeyChord('A', ['Shift', 'Control'])).toBe('Control+Shift+A')
		expect(buildKeyChord('A', ['Meta', 'Control', 'Alt', 'Shift'])).toBe(
			'Control+Alt+Shift+Meta+A',
		)
	})

	it('修饰键去重（重复写同一个只有一份）', () => {
		expect(buildKeyChord('a', ['Control', 'Control'])).toBe('Control+a')
	})

	it('主键已带 + → 原样返回，不重复拼', () => {
		expect(buildKeyChord('Control+A', ['Control'])).toBe('Control+A')
		expect(buildKeyChord('Control+Shift+A', ['Shift'])).toBe('Control+Shift+A')
	})

	it('修饰键与主键同名 → 丢掉该修饰键', () => {
		expect(buildKeyChord('Control', ['Control'])).toBe('Control')
		expect(buildKeyChord('Shift', ['Shift', 'Control'])).toBe('Control+Shift')
	})

	it('空字符串安全', () => {
		expect(buildKeyChord('')).toBe('')
		expect(buildKeyChord('   ')).toBe('')
	})

	it('describeKeyChord 便于日志阅读', () => {
		expect(describeKeyChord('Control+A')).toBe('Ctrl+A')
		expect(describeKeyChord('Meta+Control+A')).toBe('Cmd+Ctrl+A')
		expect(describeKeyChord('Enter')).toBe('Enter')
	})
})
