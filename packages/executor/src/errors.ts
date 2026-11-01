/**
 * 失败归类（纯函数，可单测）。
 *
 * 目标：**不把任何失败留成裸 timeout**。每个失败都要落到语义错误码上，
 * 让 harness 的 failureCodes / 报告的失败原因可读、可聚合。
 */
import type { ErrorCode } from './types.js'

import { ElementNotFoundError } from '@rr/resolver'

/** 失败发生在哪个阶段——同一个 timeout 在不同阶段的含义不同 */
export type FailurePhase = 'resolve' | 'action' | 'expect' | 'template' | 'navigate' | 'framework'

/** 主动抛出的、已带语义码的失败（NO_EFFECT / EXPECT_MISMATCH / DIALOG_UNEXPECTED …） */
export class StepFailure extends Error {
	readonly code: ErrorCode
	readonly detail?: string

	constructor(code: ErrorCode, message: string, detail?: string) {
		super(message)
		this.name = 'StepFailure'
		this.code = code
		if (detail !== undefined) this.detail = detail
	}
}

/** 模板渲染失败（缺变量 / 语法错） */
export class TemplateError extends Error {
	readonly variable?: string

	constructor(message: string, variable?: string) {
		super(message)
		this.name = 'TemplateError'
		if (variable !== undefined) this.variable = variable
	}
}

const BROWSER_CRASH_RE =
	/Target (page, context or browser |)?(has been )?closed|browser has been closed|browser has disconnected|Target crashed|Page crashed|Protocol error.*crash/i
const NAVIGATION_RE =
	/net::ERR_|NS_ERROR_|ERR_(CONNECTION|NAME_NOT_RESOLVED|ABORTED|TIMED_OUT|SSL)/i
/** AI 兜底的 aria-ref 在导航后失效（spike B.4）：明确可识别，便于日志/重试判定 */
const AI_REF_STALE_RE = /Invalid frame in aria-ref selector/i
const ACTIONABILITY_RE =
	/intercepts pointer events|element is not visible|Element is not visible|not stable|element is not enabled|Element is not enabled|not editable|Element is not editable|outside of the viewport|element is not attached|Element is not attached|element is detached|waiting for locator|strict mode violation/i
const TIMEOUT_RE = /Timeout \d+ms exceeded|timed out/i

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message
	if (typeof err === 'string') return err
	try {
		return JSON.stringify(err)
	} catch {
		return String(err)
	}
}

/**
 * 归类规则（顺序重要）：
 * 1. 已带语义码的 StepFailure / TemplateError / ElementNotFoundError 直接映射；
 * 2. 浏览器崩溃 / 连接断开；
 * 3. 网络类错误（导航失败）；
 * 4. Playwright actionability 关键词 → NOT_ACTIONABLE；
 * 5. 兜底 timeout 按阶段解释；
 * 6. 其余按阶段给默认码。
 */
export function classifyError(
	err: unknown,
	phase: FailurePhase,
): { code: ErrorCode; message: string } {
	const message = messageOf(err)

	if (err instanceof StepFailure) return { code: err.code, message }
	if (err instanceof TemplateError) {
		return { code: 'VARIABLE_MISSING', message: `变量渲染失败：${message}` }
	}
	if (err instanceof ElementNotFoundError) {
		// 元素存在但不可见 → 不是"找不到"，而是不可交互
		if (err.code === 'HIDDEN') return { code: 'NOT_ACTIONABLE', message: err.describe() }
		return { code: 'ELEMENT_NOT_FOUND', message: err.describe() }
	}

	if (BROWSER_CRASH_RE.test(message)) return { code: 'BROWSER_CRASH', message }
	if (AI_REF_STALE_RE.test(message)) {
		return {
			code: 'ELEMENT_NOT_FOUND',
			message: `AI 的 aria ref 已失效（导航/刷新后必须重新快照，可重试）：${message}`,
		}
	}
	if (NAVIGATION_RE.test(message)) return { code: 'NAVIGATION_FAILED', message }
	if (ACTIONABILITY_RE.test(message)) return { code: 'NOT_ACTIONABLE', message }

	if (TIMEOUT_RE.test(message)) {
		if (phase === 'navigate') return { code: 'NAVIGATION_FAILED', message }
		if (phase === 'expect')
			return { code: 'EXPECT_MISMATCH', message: `期望未在超时内满足：${message}` }
		if (phase === 'resolve') return { code: 'ELEMENT_NOT_FOUND', message }
		return { code: 'NOT_ACTIONABLE', message: `动作未能在超时内完成：${message}` }
	}

	switch (phase) {
		case 'navigate':
			return { code: 'NAVIGATION_FAILED', message }
		case 'expect':
			return { code: 'EXPECT_MISMATCH', message }
		case 'resolve':
			return { code: 'ELEMENT_NOT_FOUND', message }
		case 'template':
			return { code: 'VARIABLE_MISSING', message }
		case 'framework':
			return { code: 'BROWSER_CRASH', message }
		default:
			return { code: 'NOT_ACTIONABLE', message }
	}
}
