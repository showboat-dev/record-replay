import { describe, expect, it } from 'vitest'

import { DialogManager } from './index.js'
import { StepFailure } from './index.js'

interface FakeDialogOptions {
	type?: 'alert' | 'confirm' | 'prompt'
	message?: string
	acceptThrows?: boolean
}

function fakeDialog(options: FakeDialogOptions = {}) {
	const calls: Array<{ action: string; promptText?: string }> = []
	const dialog = {
		type: () => options.type ?? 'alert',
		message: () => options.message ?? 'hello',
		accept: async (promptText?: string) => {
			if (options.acceptThrows) throw new Error('dialog already handled')
			calls.push({ action: 'accept', ...(promptText !== undefined ? { promptText } : {}) })
		},
		dismiss: async () => {
			calls.push({ action: 'dismiss' })
		},
	}
	return { dialog, calls }
}

describe('executor: 对话框状态机（auto / fail）', () => {
	it('auto 模式：出现即 dismiss，不进入待处理队列', async () => {
		const manager = new DialogManager('auto')
		const { dialog, calls } = fakeDialog()
		manager.handle(null, dialog)
		await new Promise((r) => setTimeout(r, 0))
		expect(calls).toEqual([{ action: 'dismiss' }])
		expect(manager.pendingCount).toBe(0)
		expect(manager.history).toHaveLength(1)
	})

	it('fail 模式：记录失败并 dismiss（避免页面被阻塞）', async () => {
		const manager = new DialogManager('fail')
		const { dialog, calls } = fakeDialog()
		manager.handle(null, dialog)
		await new Promise((r) => setTimeout(r, 0))
		expect(calls).toEqual([{ action: 'dismiss' }])
		expect(manager.takeFailure()).toContain('alert')
		expect(manager.takeFailure()).toBeUndefined()
	})
})

describe('executor: 对话框状态机（manual，dialog 步骤驱动）', () => {
	it('只暂存不处理（页面保持阻塞，等 dialog 步骤）', () => {
		const manager = new DialogManager('manual')
		const { dialog, calls } = fakeDialog({ type: 'confirm' })
		manager.handle(null, dialog)
		expect(calls).toEqual([])
		expect(manager.pendingCount).toBe(1)
		expect(manager.pendingList()[0]?.info).toContain('confirm')
	})

	it('accept：处理最早的一个，prompt 带输入文本', async () => {
		const manager = new DialogManager('manual')
		const first = fakeDialog({ type: 'prompt', message: '名字？' })
		const second = fakeDialog({ type: 'confirm' })
		manager.handle(null, first.dialog)
		manager.handle(null, second.dialog)
		expect(manager.pendingCount).toBe(2)

		const handled = await manager.resolve('accept', '张三', 500)
		expect(handled.info).toContain('prompt')
		expect(first.calls).toEqual([{ action: 'accept', promptText: '张三' }])
		expect(second.calls).toEqual([])
		expect(manager.pendingCount).toBe(1)
	})

	it('dismiss：不带 promptText 调用 dismiss', async () => {
		const manager = new DialogManager('manual')
		const { dialog, calls } = fakeDialog({ type: 'confirm' })
		manager.handle(null, dialog)
		await manager.resolve('dismiss', undefined, 500)
		expect(calls).toEqual([{ action: 'dismiss' }])
	})

	it('对话框来自上一步动作：动作结束后才出现，dialog 步骤等待它', async () => {
		const manager = new DialogManager('manual')
		const { dialog, calls } = fakeDialog({ type: 'alert' })
		setTimeout(() => manager.handle(null, dialog), 80)
		const pending = await manager.waitFor(2_000)
		expect(pending?.info).toContain('alert')
		await manager.resolve('accept', undefined, 2_000)
		expect(calls).toEqual([{ action: 'accept' }])
	})

	it('没有对话框 → 等超时后 DIALOG_UNEXPECTED（消息可读，不是裸 timeout）', async () => {
		const manager = new DialogManager('manual')
		try {
			await manager.resolve('accept', undefined, 80)
			throw new Error('应当抛错')
		} catch (err) {
			expect(err).toBeInstanceOf(StepFailure)
			expect((err as StepFailure).code).toBe('DIALOG_UNEXPECTED')
			expect((err as StepFailure).message).toContain('accept')
			expect((err as StepFailure).message).toContain('没有出现')
		}
	})

	it('accept 抛错（已被处理/已关闭）→ DIALOG_UNEXPECTED', async () => {
		const manager = new DialogManager('manual')
		const { dialog } = fakeDialog({ acceptThrows: true })
		manager.handle(null, dialog)
		await expect(manager.resolve('accept', 'x', 100)).rejects.toMatchObject({
			code: 'DIALOG_UNEXPECTED',
		})
		// 失败也要把待处理项移出队列，避免卡死
		expect(manager.pendingCount).toBe(0)
	})

	it('dismissRemaining：run 结束时清掉残留对话框', async () => {
		const manager = new DialogManager('manual')
		const first = fakeDialog()
		const second = fakeDialog()
		manager.handle(null, first.dialog)
		manager.handle(null, second.dialog)
		expect(await manager.dismissRemaining()).toBe(2)
		expect(manager.pendingCount).toBe(0)
		expect(first.calls).toEqual([{ action: 'dismiss' }])
	})
})
