import type { BrowserContext, Page } from 'playwright'
import { describe, expect, it } from 'vitest'

import { PageManager, resolveStepPageIndex } from './index.js'
import { StepFailure } from './index.js'

describe('executor: 步骤 → 目标标签页', () => {
	it('未指定 page → 沿用当前（不切页）', () => {
		expect(resolveStepPageIndex({ kind: 'click' }, 0)).toBe(0)
		expect(resolveStepPageIndex({ kind: 'click' }, 2)).toBe(2)
		expect(resolveStepPageIndex({ kind: 'input' }, 1)).toBe(1)
	})

	it('step.page 显式指定 → 用它', () => {
		expect(resolveStepPageIndex({ kind: 'input', page: { index: 1 } }, 0)).toBe(1)
		expect(resolveStepPageIndex({ kind: 'assert', page: { index: 2 } }, 2)).toBe(2)
	})

	it('switchTab → 用它自己的 index', () => {
		expect(resolveStepPageIndex({ kind: 'switchTab', index: 3 }, 0)).toBe(3)
		expect(resolveStepPageIndex({ kind: 'switchTab', index: 1 }, 1)).toBe(1)
	})

	it('step.page 与 switchTab.index 冲突 → 以 step.page 为准', () => {
		expect(resolveStepPageIndex({ kind: 'switchTab', index: 1, page: { index: 2 } }, 0)).toBe(2)
	})

	it('老 flow 既没有 page 也没有 index 字段 → 不抛、沿用当前', () => {
		expect(resolveStepPageIndex({ kind: 'click', page: undefined, index: undefined }, 1)).toBe(1)
	})
})

/** 极简假 Page：PageManager 只用到 on('close')/bringToFront/waitForLoadState/url */
function fakePage(url = 'about:blank') {
	let closedHandler: (() => void) | undefined
	const page = {
		url: () => url,
		bringToFront: async () => {},
		waitForLoadState: async () => {},
		on: (event: string, handler: () => void) => {
			if (event === 'close') closedHandler = handler
			return page
		},
		close: () => {
			closedHandler?.()
			return Promise.resolve()
		},
	}
	return page as unknown as Page & { close: () => Promise<void> }
}

function fakeContext(pages: Page[]) {
	const handlers: Array<(page: Page) => void> = []
	const context = {
		pages: () => pages,
		on: (event: string, handler: (page: Page) => void) => {
			if (event === 'page') handlers.push(handler)
			return context
		},
		open: (page: Page) => {
			pages.push(page)
			for (const handler of handlers) handler(page)
		},
	}
	return context as unknown as BrowserContext & { open: (page: Page) => void }
}

describe('executor: PageManager', () => {
	it('index 0 = 起点页，new page 事件按创建顺序追加', () => {
		const first = fakePage('a')
		const context = fakeContext([first]) as ReturnType<typeof fakeContext>
		const manager = new PageManager(context as unknown as BrowserContext)
		expect(manager.count).toBe(1)
		expect(manager.currentIndex).toBe(0)
		expect(manager.current()).toBe(first)

		context.open(fakePage('b'))
		expect(manager.count).toBe(2)
		expect(manager.currentIndex).toBe(0)
	})

	it('focus 切页 + 更新 currentIndex', async () => {
		const first = fakePage('a')
		const context = fakeContext([first]) as ReturnType<typeof fakeContext>
		const manager = new PageManager(context as unknown as BrowserContext)
		context.open(fakePage('b'))

		await manager.focus(1, 500)
		expect(manager.currentIndex).toBe(1)
		expect(manager.current().url()).toBe('b')
	})

	it('waitForPage 超时 → NAVIGATION_FAILED（语义错误，不是裸 timeout）', async () => {
		const context = fakeContext([fakePage('a')]) as ReturnType<typeof fakeContext>
		const manager = new PageManager(context as unknown as BrowserContext)
		await expect(manager.waitForPage(3, 80)).rejects.toMatchObject({ code: 'NAVIGATION_FAILED' })
	})

	it('waitForPage 会等异步出现的新标签页', async () => {
		const context = fakeContext([fakePage('a')]) as ReturnType<typeof fakeContext>
		const manager = new PageManager(context as unknown as BrowserContext)
		setTimeout(() => context.open(fakePage('late')), 60)
		const slot = await manager.waitForPage(1, 2_000)
		expect(slot.index).toBe(1)
	})

	it('页被关闭：index 不重排，切过去报 NAVIGATION_FAILED；current 自动回退', async () => {
		const first = fakePage('a') as Page & { close: () => Promise<void> }
		const second = fakePage('b') as Page & { close: () => Promise<void> }
		const context = fakeContext([first, second]) as ReturnType<typeof fakeContext>
		const manager = new PageManager(context as unknown as BrowserContext)

		await manager.focus(1, 500)
		expect(manager.currentIndex).toBe(1)
		await second.close()

		expect(manager.count).toBe(2) // index 不重排
		expect(manager.openCount).toBe(1)
		await expect(manager.focus(1, 100)).rejects.toMatchObject({ code: 'NAVIGATION_FAILED' })

		// 当前页关了 → current 回退到还活着的 0
		expect(manager.currentIndex).toBe(1)
		expect(manager.current()).toBe(first)
		expect(manager.currentIndex).toBe(0)
	})

	it('所有页都关了 → BROWSER_CRASH（而不是 TypeError）', async () => {
		const first = fakePage('a') as Page & { close: () => Promise<void> }
		const context = fakeContext([first]) as ReturnType<typeof fakeContext>
		const manager = new PageManager(context as unknown as BrowserContext)
		await first.close()
		expect(() => manager.current()).toThrow(StepFailure)
		try {
			manager.current()
		} catch (err) {
			expect((err as StepFailure).code).toBe('BROWSER_CRASH')
		}
	})
})
