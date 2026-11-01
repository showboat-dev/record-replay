/**
 * Resolver 的语义错误。
 *
 * 契约（docs/architecture.md §4）：解析不到抛 `ElementNotFoundError`，executor 负责归类。
 * 这里用 `code` 携带原因，让 executor 能把「真的有歧义」和「元素不存在」分开统计，
 * 而不是把所有失败都塞进一个 ELEMENT_NOT_FOUND。
 */
import type { ElementRef } from '@rr/schema'

export type ResolverErrorCode =
	/** 所有层级都没有命中 */
	| 'NO_MATCH'
	/** 命中多个且 top1/top2 分差 < 15%（不猜，降级后仍无法唯一确定） */
	| 'AMBIGUOUS'
	/** 唯一命中但不可见（存在但不 actionable） */
	| 'HIDDEN'
	/** ElementRef 本身不合法（candidates 为空、role 候选缺 role 字段等） */
	| 'INVALID_REF'
	/** frame 链走不进去（frame 元素找不到 / urlPattern 不匹配 / index 越界） */
	| 'INVALID_FRAME'
	/** 配了 AI 但 AI 也没给出可用定位 */
	| 'AI_FAILED'

export class ElementNotFoundError extends Error {
	readonly code: ResolverErrorCode
	readonly target: ElementRef
	readonly details: Record<string, unknown>

	constructor(
		code: ResolverErrorCode,
		target: ElementRef,
		message: string,
		details: Record<string, unknown> = {},
	) {
		super(message)
		this.name = 'ElementNotFoundError'
		this.code = code
		this.target = target
		this.details = details
	}

	/** 单行摘要，写进 StepResult.error.message 用 */
	describe(): string {
		const tag = this.target.observed.tag
		const id = this.target.observed.attributes['id']
		const label = id ? `<${tag} id="${id}">` : `<${tag}>`
		return `${this.code}: ${label} — ${this.message}`
	}
}
