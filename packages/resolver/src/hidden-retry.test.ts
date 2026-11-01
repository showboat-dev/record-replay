/**
 * HIDDEN（命中但不可见）重试回归。
 *
 * 真实场景（flows/smoke-hover.json）：hover 展开菜单是异步的（~250ms），
 * 上一步 hover 之后立刻点菜单项，元素已存在但 isVisible() 还是 false。
 * resolver 必须在 elementWaitMs 内轮询重试，不能把"暂时不可见"当终态失败。
 */
import type { ElementRef, Rect } from '@rr/schema'
import type { Locator, Page } from 'playwright'
import { describe, expect, it } from 'vitest'

import { resolve } from './index.js'

const rect: Rect = { x: 10, y: 20, width: 100, height: 30 }

function target(): ElementRef {
	return {
		observed: {
			tag: 'button',
			attributes: { id: 'hover-export' },
			text: '导出',
			rect,
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: [{ kind: 'testid', value: 'hover-export', score: 1, source: 'record' }],
		fingerprint: {
			tag: 'button',
			role: 'button',
			accessibleName: '导出',
			attrs: { id: 'hover-export' },
			stableHash: 'deadbeef',
		},
		frame: { path: [] },
	}
}

/** 假 locator：isVisible 在 visibleAfterMs 之后才变 true（模拟菜单展开动画） */
function fakeLocator(options: { visibleAfterMs: number; appearAfterMs?: number }): Locator {
	const start = Date.now()
	return {
		count: async () => (Date.now() - start >= (options.appearAfterMs ?? 0) ? 1 : 0),
		isVisible: async () => Date.now() - start >= options.visibleAfterMs,
		evaluateAll: async () => [rect],
		nth: () => fakeLocator(options),
		waitFor: async () => undefined,
	} as unknown as Locator
}

function fakePage(locator: Locator): Page {
	return {
		getByTestId: () => locator,
		getByRole: () => locator,
		getByLabel: () => locator,
		getByText: () => locator,
		locator: () => locator,
		waitForLoadState: async () => undefined,
		url: () => 'http://127.0.0.1:5173/hover-menu',
	} as unknown as Page
}

describe('resolver: HIDDEN 轮询重试（hover 展开菜单这类异步可见性）', () => {
	it('元素先存在但不可见，250ms 后可见 → 重试后命中 L1（不是 HIDDEN 失败）', async () => {
		const locator = fakeLocator({ visibleAfterMs: 250 })
		const result = await resolve(target(), {
			page: fakePage(locator),
			options: { elementWaitMs: 3_000, elementWaitPollMs: 50 },
		})
		expect(result.level).toBe('L1')
		expect(result.score).toBe(100)
	}, 10_000)

	it('超过 elementWaitMs 仍不可见 → 报 HIDDEN（保留语义，不退化成 NO_MATCH）', async () => {
		const locator = fakeLocator({ visibleAfterMs: 60_000 })
		try {
			await resolve(target(), {
				page: fakePage(locator),
				options: { elementWaitMs: 300, elementWaitPollMs: 50 },
			})
			throw new Error('应当抛 HIDDEN')
		} catch (err) {
			expect((err as { code?: string }).code).toBe('HIDDEN')
		}
	}, 10_000)

	it('requireVisible=false 时不做可见性等待（expect.elementHidden 场景）', async () => {
		const locator = fakeLocator({ visibleAfterMs: 60_000 })
		const started = Date.now()
		const result = await resolve(target(), {
			page: fakePage(locator),
			options: { requireVisible: false, elementWaitMs: 3_000, elementWaitPollMs: 50 },
		})
		expect(result.level).toBe('L1')
		expect(Date.now() - started).toBeLessThan(1_000)
	}, 10_000)
})
