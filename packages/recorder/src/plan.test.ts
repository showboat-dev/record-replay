/**
 * plan.ts 单测：标签页切换合成 / 对话框插入位置 / hover 意义过滤 / 下载与上传。
 * 全是纯函数，不需要浏览器。
 */
import { describe, expect, it } from 'vitest'

import {
	downloadFilenamePattern,
	findDownloadFor,
	hasHoverSemantics,
	isMeaningfulHover,
	insertDialogs,
	pageIndexOf,
	uploadVariableName,
	withTabSwitches,
} from './plan.js'
import type { CoalescedAction, PlannedItem, RecordedDownload, RawElementFacts } from './types.js'

function facts(uid: string, extra: Partial<RawElementFacts> = {}): RawElementFacts {
	return {
		uid,
		tag: 'button',
		attributes: {},
		rect: { x: 0, y: 0, width: 80, height: 30 },
		scroll: { x: 0, y: 0 },
		viewport: { width: 1440, height: 900 },
		dpr: 1,
		recordedAt: 1_700_000_000_000,
		...extra,
	}
}

function act(partial: Partial<CoalescedAction> & { kind: CoalescedAction['kind']; ts: number }): CoalescedAction {
	return { merged: 1, raw: [], ...partial }
}

function hover(ts: number, uid: string, attrs: Record<string, string> = {}): CoalescedAction {
	return act({ kind: 'hover', ts, facts: facts(uid, { attributes: attrs }) })
}

function click(ts: number, uid: string): CoalescedAction {
	return act({ kind: 'click', ts, facts: facts(uid), button: 'left', clickCount: 1 })
}

describe('withTabSwitches —— 标签页切换合成', () => {
	it('同页动作不插 switchTab', () => {
		const state = { page: 0 }
		const items = withTabSwitches([click(1, 'a'), click(2, 'b')], state)
		expect(items.map((item) => item.kind)).toEqual(['action', 'action'])
		expect(state.page).toBe(0)
	})

	it('pageIndex 变化时在动作前插一条 switchTab', () => {
		const state = { page: 0 }
		const items = withTabSwitches(
			[click(1, 'a'), { ...click(2, 'b'), pageIndex: 1 }, click(3, 'c')],
			state,
		)
		expect(items.map((item) => item.kind)).toEqual(['action', 'switchTab', 'action', 'action'])
		const switchItem = items[1] as Extract<PlannedItem, { kind: 'switchTab' }>
		expect(switchItem.index).toBe(1)
		expect(switchItem.ts).toBe(2)
		expect(state.page).toBe(1)
	})

	it('跨批次复用 state：第二批才发现切页也会插', () => {
		const state = { page: 0 }
		withTabSwitches([click(1, 'a')], state)
		const items = withTabSwitches([{ ...click(10, 'b'), pageIndex: 1 }], state)
		expect(items.map((item) => item.kind)).toEqual(['switchTab', 'action'])
	})

	it('切回原标签页也会再插一次（回放需要显式来回切）', () => {
		const state = { page: 0 }
		withTabSwitches([{ ...click(1, 'a'), pageIndex: 1 }], state)
		const items = withTabSwitches([{ ...click(2, 'b'), pageIndex: 0 }], state)
		expect(items.map((item) => item.kind)).toEqual(['switchTab', 'action'])
		expect((items[0] as Extract<PlannedItem, { kind: 'switchTab' }>).index).toBe(0)
	})

	it('pageIndexOf 缺省用当前页', () => {
		expect(pageIndexOf(click(1, 'a'), 2)).toBe(2)
		expect(pageIndexOf({ ...click(1, 'a'), pageIndex: 1 }, 2)).toBe(1)
	})
})

describe('insertDialogs —— 对话框紧跟触发步骤', () => {
	const dialog = (ts: number, promptText?: string) => ({
		ts,
		pageIndex: 0,
		action: 'accept' as const,
		...(promptText === undefined ? {} : { promptText }),
	})

	it('dialog 插在触发它的 click 之后、下一步之前', () => {
		const items: PlannedItem[] = [
			{ kind: 'action', action: click(1000, 'a') },
			{ kind: 'action', action: click(3000, 'b') },
		]
		const result = insertDialogs(items, [dialog(1002)])
		expect(result.items.map((item) => item.kind)).toEqual(['action', 'dialog', 'action'])
		expect(result.consumed).toHaveLength(1)
	})

	it('dialog 时间正好等于 click 时间也插在 click 之后', () => {
		const result = insertDialogs([{ kind: 'action', action: click(1000, 'a') }], [dialog(1000)])
		expect(result.items.map((item) => item.kind)).toEqual(['action', 'dialog'])
	})

	it('没有动作时 dialog 排在末尾，不丢', () => {
		const result = insertDialogs([], [dialog(1000)])
		expect(result.items.map((item) => item.kind)).toEqual(['dialog'])
	})

	it('多个 dialog 保序', () => {
		const result = insertDialogs(
			[{ kind: 'action', action: click(1000, 'a') }],
			[dialog(1001), dialog(1002, 'hi')],
		)
		const kinds = result.items.map((item) => item.kind)
		expect(kinds).toEqual(['action', 'dialog', 'dialog'])
		const second = result.items[2] as Extract<PlannedItem, { kind: 'dialog' }>
		expect(second.promptText).toBe('hi')
	})

	it('dialog 早于所有动作（如页面加载即弹）→ 排在第一个动作之前', () => {
		const result = insertDialogs([{ kind: 'action', action: click(2000, 'a') }], [dialog(1000)])
		expect(result.items.map((item) => item.kind)).toEqual(['dialog', 'action'])
	})

	it('空 dialogs 原样返回', () => {
		const items: PlannedItem[] = [{ kind: 'action', action: click(1000, 'a') }]
		const result = insertDialogs(items, [])
		expect(result.items).toBe(items)
		expect(result.consumed).toEqual([])
	})
})

describe('hover 意义过滤', () => {
	it('aria-haspopup 的 hover 直接保留', () => {
		expect(hasHoverSemantics(hover(1000, 'menu', { 'aria-haspopup': 'true' }))).toBe(true)
		expect(isMeaningfulHover(hover(1000, 'menu', { 'aria-haspopup': 'menu' }), [])).toBe(true)
	})

	it('aria-expanded 的 hover 直接保留', () => {
		expect(isMeaningfulHover(hover(1000, 'tab', { 'aria-expanded': 'false' }), [])).toBe(true)
	})

	it('悬停后 2s 内点了另一个元素 → 保留（「悬停展开再点菜单项」）', () => {
		expect(isMeaningfulHover(hover(1000, 'menu'), [click(1800, 'item')])).toBe(true)
	})

	it('点击的是自己 → 丢弃（普通点击前的划过）', () => {
		expect(isMeaningfulHover(hover(1000, 'btn'), [click(1200, 'btn')])).toBe(false)
	})

	it('点击发生在 2s 之后 → 丢弃', () => {
		expect(isMeaningfulHover(hover(1000, 'menu'), [click(3500, 'item')])).toBe(false)
	})

	it('后面只有 input 没有 click → 丢弃', () => {
		expect(isMeaningfulHover(hover(1000, 'menu'), [act({ kind: 'input', ts: 1200, facts: facts('i') })])).toBe(false)
	})

	it('没有任何属性也没有后续点击 → 丢弃（鼠标划过的噪声）', () => {
		expect(isMeaningfulHover(hover(1000, 'div'), [])).toBe(false)
	})
})

describe('下载', () => {
	it('文件名 pattern：动态数字段变 *', () => {
		expect(downloadFilenamePattern('hello-from-rr.txt')).toBe('hello-from-rr.txt')
		expect(downloadFilenamePattern('export-20261101.csv')).toBe('export-*.csv')
		expect(downloadFilenamePattern('report_1234567890.xlsx')).toBe('report_*.xlsx')
	})

	it('带路径的文件名只取 basename', () => {
		expect(downloadFilenamePattern('/tmp/some/dir/a-99.log')).toBe('a-*.log')
	})

	it('空文件名兜底为 *', () => {
		expect(downloadFilenamePattern('')).toBe('*')
	})

	const download = (ts: number, pageIndex = 0): RecordedDownload => ({
		ts,
		pageIndex,
		filename: 'a.txt',
	})

	it('findDownloadFor 命中「本动作到下一动作之间」的同页下载', () => {
		const found = findDownloadFor(act({ kind: 'click', ts: 1000 }), [download(1200)], new Set(), 2000)
		expect(found?.filename).toBe('a.txt')
	})

	it('落在下一个动作之后的下载不挂到本步', () => {
		expect(findDownloadFor(act({ kind: 'click', ts: 1000 }), [download(2500)], new Set(), 2000)).toBeUndefined()
	})

	it('早于动作发生的下载不挂到本步', () => {
		expect(findDownloadFor(act({ kind: 'click', ts: 3000 }), [download(1000)], new Set(), 4000)).toBeUndefined()
	})

	it('已消费的下载不会重复命中', () => {
		const entry = download(1200)
		const consumed = new Set([entry])
		expect(findDownloadFor(act({ kind: 'click', ts: 1000 }), [entry], consumed, 2000)).toBeUndefined()
	})

	it('别的标签页的下载不挂到本步', () => {
		expect(findDownloadFor(act({ kind: 'click', ts: 1000 }), [download(1200, 1)], new Set(), 2000)).toBeUndefined()
	})

	it('批内最后一个动作（无 nextTs）也能挂到之后的下载', () => {
		expect(findDownloadFor(act({ kind: 'click', ts: 1000 }), [download(1200)], new Set(), undefined)?.filename).toBe('a.txt')
	})
})

describe('上传占位变量', () => {
	it('file_1 / file_2 …（合法标识符）', () => {
		expect(uploadVariableName(1)).toBe('file_1')
		expect(uploadVariableName(12)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
	})
})
