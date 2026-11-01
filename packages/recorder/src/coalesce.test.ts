/**
 * 事件合流单测：双击 / 输入 / 滚动 / 导航 四类合并 + 两条后置过滤。
 */
import { describe, expect, it } from 'vitest'

import { coalesceEvents } from './coalesce.js'
import type { RawElementFacts, RawEvent } from './types.js'

function facts(uid: string, tag = 'button', extra: Partial<RawElementFacts> = {}): RawElementFacts {
	return {
		uid,
		tag,
		attributes: {},
		text: '按钮',
		rect: { x: 10, y: 20, width: 80, height: 30 },
		scroll: { x: 0, y: 0 },
		viewport: { width: 1440, height: 900 },
		dpr: 1,
		recordedAt: 1_700_000_000_000,
		...extra,
	}
}

function click(ts: number, uid = 'a', button = 0): RawEvent {
	return { kind: 'click', ts, facts: facts(uid), data: { button }, trusted: true }
}

function inputEvent(ts: number, uid: string, value: string): RawEvent {
	return { kind: 'input', ts, facts: facts(uid, 'input'), data: { value }, trusted: false }
}

function keydown(ts: number, uid: string, key: string): RawEvent {
	return {
		kind: 'keydown',
		ts,
		facts: facts(uid, 'input'),
		data: { key, isPrintable: key.length === 1 },
		trusted: true,
	}
}

function scrollEvent(ts: number, dx: number, dy: number, uid?: string): RawEvent {
	return {
		kind: 'scroll',
		ts,
		facts: uid ? facts(uid, 'div') : undefined,
		data: { dx, dy },
		trusted: true,
	}
}

describe('coalesceEvents —— 双击合并', () => {
	it('两次同元素 click 在 500ms 内 → clickCount=2', () => {
		const actions = coalesceEvents([click(1000), click(1120)])
		expect(actions).toHaveLength(1)
		expect(actions[0]).toMatchObject({ kind: 'click', clickCount: 2, button: 'left' })
		expect(actions[0]?.merged).toBe(2)
	})

	it('超过 500ms 的两次 click 不合并', () => {
		const actions = coalesceEvents([click(1000), click(1700)])
		expect(actions.map((a) => a.clickCount)).toEqual([1, 1])
	})

	it('不同元素的 click 不合并', () => {
		const actions = coalesceEvents([click(1000, 'a'), click(1050, 'b')])
		expect(actions).toHaveLength(2)
	})

	it('三次 click 合到 schema 上限 3 为止', () => {
		const actions = coalesceEvents([click(1000), click(1100), click(1200), click(1300)])
		expect(actions.map((a) => a.clickCount)).toEqual([3, 1])
	})

	it('右键（contextmenu）单独成一次 button=right 的 click', () => {
		const actions = coalesceEvents([
			{ kind: 'contextmenu', ts: 1000, facts: facts('a'), data: { button: 2 }, trusted: true },
		])
		expect(actions[0]).toMatchObject({ kind: 'click', button: 'right', clickCount: 1 })
	})
})

describe('coalesceEvents —— 输入合并', () => {
	it('同一元素连续 input 只留最后的值', () => {
		const actions = coalesceEvents([
			inputEvent(1000, 'in', 'a'),
			inputEvent(1050, 'in', 'al'),
			inputEvent(1100, 'in', 'ali'),
		])
		expect(actions).toHaveLength(1)
		expect(actions[0]).toMatchObject({ kind: 'input', value: 'ali' })
	})

	it('慢速输入（间隔 < 2s）仍然合并成一次 input', () => {
		const actions = coalesceEvents([inputEvent(1000, 'in', 'a'), inputEvent(2500, 'in', 'ab')])
		expect(actions).toHaveLength(1)
		expect(actions[0]?.value).toBe('ab')
	})

	it('checkbox 的 input/change 不产生动作（由 click 覆盖）', () => {
		const actions = coalesceEvents([
			click(1000, 'cb'),
			{ kind: 'input', ts: 1010, facts: facts('cb', 'input'), data: { checked: true }, trusted: false },
			{ kind: 'change', ts: 1020, facts: facts('cb', 'input'), data: { checked: true }, trusted: false },
		])
		expect(actions.map((a) => a.kind)).toEqual(['click'])
	})

	it('text input 后面的 change 不额外成步', () => {
		const actions = coalesceEvents([
			inputEvent(1000, 'in', 'abc'),
			{
				kind: 'change',
				ts: 1100,
				facts: facts('in', 'input'),
				data: { value: 'abc', inputType: 'text' },
				trusted: false,
			},
		])
		expect(actions).toHaveLength(1)
		expect(actions[0]?.kind).toBe('input')
	})

	it('select 的 change → select 动作（多选保留数组）', () => {
		const actions = coalesceEvents([
			{
				kind: 'change',
				ts: 1000,
				facts: facts('sel', 'select'),
				data: { selectedValues: ['cn', 'us'], value: 'cn' },
				trusted: true,
			},
		])
		expect(actions[0]).toMatchObject({ kind: 'select', selectedValues: ['cn', 'us'] })
	})

	it('password 只留 masked 标记，不留明文', () => {
		const actions = coalesceEvents([
			{ kind: 'input', ts: 1000, facts: facts('pw', 'input'), data: { masked: true }, trusted: false },
		])
		expect(actions[0]).toMatchObject({ kind: 'input', masked: true })
		expect(actions[0]?.value).toBeUndefined()
	})

	it('file input 的 change 被忽略（浏览器不暴露路径）', () => {
		const actions = coalesceEvents([
			{ kind: 'change', ts: 1000, facts: facts('f', 'input'), data: { inputType: 'file' }, trusted: true },
		])
		expect(actions).toHaveLength(0)
	})
})

describe('coalesceEvents —— keydown', () => {
	it('可打印字符 + 后面跟着 input → 丢弃 keydown', () => {
		const actions = coalesceEvents([keydown(1000, 'in', 'a'), inputEvent(1050, 'in', 'a')])
		expect(actions.map((a) => a.kind)).toEqual(['input'])
	})

	it('Enter 这类不可打印键保留为 key 动作', () => {
		const actions = coalesceEvents([{ ...keydown(1000, 'in', 'Enter'), data: { key: 'Enter', isPrintable: false } }])
		expect(actions[0]).toMatchObject({ kind: 'key', key: 'Enter' })
	})

	it('修饰键（Shift 等）不成动作', () => {
		const actions = coalesceEvents([keydown(1000, 'in', 'Shift')])
		expect(actions).toHaveLength(0)
	})
})

describe('coalesceEvents —— select / change 去重（回归）', () => {
	it('select 的 input 事件不成步（由 change 统一生成 select）', () => {
		const actions = coalesceEvents([
			{ kind: 'input', ts: 1000, facts: facts('sel', 'select'), data: { value: 'cn' }, trusted: false },
		])
		expect(actions).toHaveLength(0)
	})

	it('文本控件的 change 不成步（input 已表达值变化）', () => {
		const actions = coalesceEvents([
			{ kind: 'change', ts: 1000, facts: facts('in', 'input'), data: { value: 'x', inputType: 'text' }, trusted: true },
		])
		expect(actions).toHaveLength(0)
	})

	it('blur 补发的 change 不会在 select 之后多出一步 input', () => {
		const actions = coalesceEvents([
			inputEvent(1000, 'in', 'alice@example.com'),
			{ kind: 'change', ts: 1010, facts: facts('sel', 'select'), data: { selectedValues: ['cn'], value: 'cn' }, trusted: false },
			{ kind: 'change', ts: 1030, facts: facts('in', 'input'), data: { value: 'alice@example.com', inputType: 'email' }, trusted: true },
		])
		expect(actions.map((a) => a.kind)).toEqual(['input', 'select'])
	})
})

describe('coalesceEvents —— 点击坐标（closed shadow 兜底）', () => {
	it('click 的 offset 会被透传到动作上', () => {
		const actions = coalesceEvents([
			{ kind: 'click', ts: 1000, facts: facts('host'), data: { button: 0, offset: { x: 68, y: 144.3 } }, trusted: true },
		])
		expect(actions[0]?.offset).toEqual({ x: 68, y: 144.3 })
	})

	it('双击合并时以最后一次点击的坐标为准', () => {
		const actions = coalesceEvents([
			{ kind: 'click', ts: 1000, facts: facts('host'), data: { button: 0, offset: { x: 10, y: 10 } }, trusted: true },
			{ kind: 'click', ts: 1100, facts: facts('host'), data: { button: 0, offset: { x: 68, y: 144.3 } }, trusted: true },
		])
		expect(actions).toHaveLength(1)
		expect(actions[0]?.offset).toEqual({ x: 68, y: 144.3 })
	})
})

describe('coalesceEvents —— hover（页面已做 350ms 停留判定，这里只做合流）', () => {
	it('hover 事件成一条 hover 动作（带 facts）', () => {
		const actions = coalesceEvents([
			{ kind: 'hover', ts: 1000, facts: facts('menu', 'a'), data: { dwellMs: 350 }, trusted: true },
		])
		expect(actions).toHaveLength(1)
		expect(actions[0]).toMatchObject({ kind: 'hover', ts: 1000 })
		expect(actions[0]?.facts?.uid).toBe('menu')
	})

	it('同一元素的连续 hover 只留最后一条', () => {
		const actions = coalesceEvents([
			{ kind: 'hover', ts: 1000, facts: facts('menu', 'a'), trusted: true },
			{ kind: 'hover', ts: 1800, facts: facts('menu', 'a'), trusted: true },
		])
		expect(actions).toHaveLength(1)
		expect(actions[0]?.ts).toBe(1800)
		expect(actions[0]?.merged).toBe(2)
	})

	it('不同元素的 hover 各自保留（意义过滤在 plan.ts 做）', () => {
		const actions = coalesceEvents([
			{ kind: 'hover', ts: 1000, facts: facts('a', 'a'), trusted: true },
			{ kind: 'hover', ts: 1100, facts: facts('b', 'a'), trusted: true },
		])
		expect(actions.map((action) => action.facts?.uid)).toEqual(['a', 'b'])
	})

	it('没有 facts 的 hover 直接丢弃', () => {
		const actions = coalesceEvents([{ kind: 'hover', ts: 1000, trusted: true }])
		expect(actions).toHaveLength(0)
	})
})

describe('coalesceEvents —— 组合键', () => {
	it('Ctrl+键 → key 动作带 modifiers，且不会被 input 吞掉', () => {
		const actions = coalesceEvents([
			{
				kind: 'keydown',
				ts: 1000,
				facts: facts('in', 'input'),
				data: { key: 's', modifiers: ['Control'], isPrintable: false },
				trusted: true,
			},
		])
		expect(actions).toHaveLength(1)
		expect(actions[0]).toMatchObject({ kind: 'key', key: 's', modifiers: ['Control'] })
	})

	it('Alt+键 / Meta+键 也是组合键', () => {
		const alt = coalesceEvents([
			{ kind: 'keydown', ts: 1, facts: facts('x'), data: { key: 'ArrowLeft', modifiers: ['Alt'] }, trusted: true },
		])
		expect(alt[0]).toMatchObject({ kind: 'key', modifiers: ['Alt'] })
		const meta = coalesceEvents([
			{ kind: 'keydown', ts: 1, facts: facts('x'), data: { key: 'Enter', modifiers: ['Meta'] }, trusted: true },
		])
		expect(meta[0]).toMatchObject({ kind: 'key', modifiers: ['Meta'] })
	})

	it('Shift + 可打印字符只是打大写：不当组合键，交给 input 合并', () => {
		const actions = coalesceEvents([
			{
				kind: 'keydown',
				ts: 1000,
				facts: facts('in', 'input'),
				data: { key: 'A', modifiers: ['Shift'], isPrintable: true },
				trusted: true,
			},
			{ kind: 'input', ts: 1010, facts: facts('in', 'input'), data: { value: 'A' }, trusted: true },
		])
		expect(actions.map((action) => action.kind)).toEqual(['input'])
		expect(actions[0]?.value).toBe('A')
	})

	it('Shift+Tab 这类不可打印组合键保留 modifiers', () => {
		const actions = coalesceEvents([
			{
				kind: 'keydown',
				ts: 1000,
				facts: facts('in', 'input'),
				data: { key: 'Tab', modifiers: ['Shift'], isPrintable: false },
				trusted: true,
			},
		])
		expect(actions[0]).toMatchObject({ kind: 'key', key: 'Tab', modifiers: ['Shift'] })
	})

	it('普通 Enter 不带 modifiers 字段（保持老 flow 形状）', () => {
		const actions = coalesceEvents([
			{ kind: 'keydown', ts: 1000, facts: facts('in', 'input'), data: { key: 'Enter' }, trusted: true },
		])
		expect(actions[0]).toMatchObject({ kind: 'key', key: 'Enter' })
		expect(actions[0]?.modifiers).toBeUndefined()
	})
})

describe('coalesceEvents —— 标签页归属透传', () => {
	it('动作带上事件的 pageIndex', () => {
		const actions = coalesceEvents([
			{ kind: 'click', ts: 1000, facts: facts('a'), data: { button: 0 }, trusted: true, pageIndex: 1 },
			{ kind: 'input', ts: 1100, facts: facts('i', 'input'), data: { value: 'x' }, trusted: true, pageIndex: 0 },
		])
		expect(actions.map((action) => action.pageIndex)).toEqual([1, 0])
	})
})

describe('coalesceEvents —— 滚动', () => {
	it('同目标连续滚动 delta 累加', () => {
		const actions = coalesceEvents([scrollEvent(1000, 0, 120), scrollEvent(1200, 0, 80)])
		expect(actions).toHaveLength(1)
		expect(actions[0]?.delta).toEqual({ x: 0, y: 200 })
	})

	it('抖动（累计 < 4px）被丢弃', () => {
		const actions = coalesceEvents([scrollEvent(1000, 0, 2)])
		expect(actions).toHaveLength(0)
	})

	it('点击前的自动滚动（scrollIntoView）被丢弃', () => {
		const actions = coalesceEvents([scrollEvent(1000, 0, 400), click(1100)])
		expect(actions.map((a) => a.kind)).toEqual(['click'])
	})

	it('独立滚动（后面没有点击）保留', () => {
		const actions = coalesceEvents([scrollEvent(1000, 0, 400), click(3000)])
		expect(actions.map((a) => a.kind)).toEqual(['scroll', 'click'])
	})
})

describe('coalesceEvents —— 导航', () => {
	it('导航并入前一步的 expectUrl', () => {
		const actions = coalesceEvents([
			click(1000),
			{ kind: 'navigation', ts: 1300, url: 'http://127.0.0.1:5173/done', trusted: true },
		])
		expect(actions).toHaveLength(1)
		expect(actions[0]?.expectUrl).toBe('http://127.0.0.1:5173/done')
	})

	it('没有前一步动作时单独成 navigate', () => {
		const actions = coalesceEvents([
			{ kind: 'navigation', ts: 1000, url: 'http://127.0.0.1:5173/b', trusted: true },
		])
		expect(actions[0]).toMatchObject({ kind: 'navigate', url: 'http://127.0.0.1:5173/b' })
	})

	it('距前一步太远的导航不并入（另起 navigate）', () => {
		const actions = coalesceEvents([
			click(1000),
			{ kind: 'navigation', ts: 5000, url: 'http://x/y', trusted: true },
		])
		expect(actions.map((a) => a.kind)).toEqual(['click', 'navigate'])
	})
})

describe('coalesceEvents —— 通用', () => {
	it('pointerdown 单独不成动作', () => {
		const actions = coalesceEvents([
			{ kind: 'pointerdown', ts: 1000, facts: facts('a'), data: { button: 0 }, trusted: true },
			click(1010),
		])
		expect(actions.map((a) => a.kind)).toEqual(['click'])
	})

	it('输出按时间排序（输入即使乱序）', () => {
		const actions = coalesceEvents([click(2000), click(1000, 'other')])
		expect(actions[0]?.ts).toBe(1000)
	})

	it('bufferMs 可配置：1000ms 时 800ms 双击仍合并', () => {
		const actions = coalesceEvents([click(1000), click(1800)], { bufferMs: 1000 })
		expect(actions[0]?.clickCount).toBe(2)
	})
})
