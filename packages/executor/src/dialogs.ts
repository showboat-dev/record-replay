/**
 * 原生对话框（alert / confirm / prompt / beforeunload）状态机。
 *
 * 三种模式：
 * - `auto`：默认行为，出现就 dismiss（用户没在 flow 里显式表达对话框，不该卡死）；
 * - `fail`：出现即失败（契约里的 DIALOG_UNEXPECTED），用于"这个流程不该弹窗"的严格场景；
 * - `manual`：flow 里有 `dialog` 步骤时自动启用 —— 只**暂存**不处理，等 dialog 步骤来
 *   accept/dismiss。对话框可能由**上一步动作**触发，所以要跨步骤保留。
 *
 * 注意：Playwright 会在没有 handler 时自动 dismiss，所以必须尽早注册 handler；
 * manual 模式下对话框一直挂着（页面被阻塞），这是预期行为，由后续 dialog 步骤解开。
 */
import type { Page } from 'playwright'

import { StepFailure } from './errors.js'

export type DialogMode = 'auto' | 'manual' | 'fail'
export type DialogAction = 'accept' | 'dismiss'

/** 只需要这几个方法（Playwright 的 Dialog 结构兼容，单测可传假对象） */
export interface DialogLike {
	type(): string
	message(): string
	accept(promptText?: string): Promise<void>
	dismiss(): Promise<void>
}

export interface PendingDialog {
	dialog: DialogLike
	page: Page | null
	info: string
	at: number
}

export class DialogManager {
	readonly mode: DialogMode
	/** 历史（全部对话框，写 result.json 用） */
	readonly history: string[] = []
	readonly #pending: PendingDialog[] = []
	readonly #failures: string[] = []
	readonly #log: (msg: string) => void

	constructor(mode: DialogMode, log: (msg: string) => void = () => {}) {
		this.mode = mode
		this.#log = log
	}

	/** 事件入口：由 run.ts 在每个 page 上注册 page.on('dialog') 时调用 */
	handle(page: Page | null, dialog: DialogLike): void {
		const info = `${dialog.type()}: ${dialog.message()}`
		this.history.push(info)
		this.#log(`检测到 JS 对话框（mode=${this.mode}）：${info}`)

		if (this.mode === 'auto') {
			void dialog.dismiss().catch((err: unknown) => {
				this.#log(`自动关闭对话框失败：${(err as Error).message}`)
			})
			return
		}
		if (this.mode === 'fail') {
			this.#failures.push(info)
			// 仍然 dismiss，否则页面一直被阻塞，后面的报错会变成看不懂的 timeout
			void dialog.dismiss().catch(() => {})
			return
		}
		this.#pending.push({ dialog, page, info, at: Date.now() })
	}

	get pendingCount(): number {
		return this.#pending.length
	}

	pendingList(): PendingDialog[] {
		return [...this.#pending]
	}

	/** 等一个待处理对话框出现（dialog 步骤用）；超时返回 undefined 由调用方决定错误码 */
	async waitFor(timeoutMs: number, pollMs = 50): Promise<PendingDialog | undefined> {
		const deadline = Date.now() + Math.max(0, timeoutMs)
		for (;;) {
			const first = this.#pending[0]
			if (first) return first
			if (Date.now() >= deadline) return undefined
			await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs))
		}
	}

	/**
	 * 处理最早的一个待处理对话框。
	 * 超时（没有任何对话框）→ DIALOG_UNEXPECTED，消息里写明"期望的 action"，
	 * 让失败原因可读（不是裸 timeout）。
	 */
	async resolve(
		action: DialogAction,
		promptText: string | undefined,
		timeoutMs: number,
	): Promise<PendingDialog> {
		const pending = await this.waitFor(timeoutMs)
		if (!pending) {
			throw new StepFailure(
				'DIALOG_UNEXPECTED',
				`dialog 步骤要求 ${action}，但 ${timeoutMs}ms 内没有出现任何原生对话框` +
					`（若上一步本应弹窗，检查页面是否真的触发了 alert/confirm/prompt）`,
			)
		}
		const index = this.#pending.indexOf(pending)
		if (index >= 0) this.#pending.splice(index, 1)

		try {
			if (action === 'accept') {
				await (promptText !== undefined
					? pending.dialog.accept(promptText)
					: pending.dialog.accept())
			} else {
				await pending.dialog.dismiss()
			}
		} catch (err) {
			throw new StepFailure(
				'DIALOG_UNEXPECTED',
				`处理对话框失败（${pending.info}，action=${action}）：${(err as Error).message}`,
			)
		}
		this.#log(
			`对话框已 ${action}${promptText !== undefined ? `（输入 "${promptText}"）` : ''}：${pending.info}`,
		)
		return pending
	}

	/** fail 模式下取走一条"不该出现的对话框"记录（由 run.ts 转成步骤失败） */
	takeFailure(): string | undefined {
		return this.#failures.shift()
	}

	/** run 结束前清理：残留的 manual 对话框全部 dismiss，避免 browser.close 时挂住 */
	async dismissRemaining(): Promise<number> {
		let dismissed = 0
		for (const pending of this.#pending.splice(0)) {
			try {
				await pending.dialog.dismiss()
				dismissed += 1
			} catch {
				/* 页面可能已经关了 */
			}
		}
		if (dismissed > 0) this.#log(`回放结束，自动关闭了 ${dismissed} 个残留对话框`)
		return dismissed
	}
}
