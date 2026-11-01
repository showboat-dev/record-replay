/**
 * expect / assert 校验（契约见 docs/architecture.md §5）。
 *
 * 设计要点：
 * - 所有"等待类"期望都轮询到 5s（默认）而不是一次性判定，避免动画/异步渲染造成假失败；
 * - elementHidden 把「元素从 DOM 里消失」也算通过（unmount 是最常见的隐藏方式）；
 * - domSignature 用 sha1(region.innerHTML)，region 默认 body。
 */
import { createHash } from 'node:crypto'

import type { Assertion, ElementRef, Expect } from '@rr/schema'
import type { Page } from 'playwright'
import { ElementNotFoundError, wildcardToRegExp, type ResolveResult } from '@rr/resolver'

import { StepFailure } from './errors.js'

export interface VerifyDeps {
	page: Page
	/** 用当前 run 的解析器（expect 场景不带 AI，避免额外调用） */
	resolveTarget: (target: ElementRef, opts?: { requireVisible?: boolean }) => Promise<ResolveResult>
	timeoutMs: number
	log: (msg: string) => void
}

/** 期望校验的默认等待上限（契约：elementVisible/Hidden 轮询 5s） */
export const EXPECT_WAIT_MS = 5_000
const POLL_MS = 100

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询直到 attempt 返回非 undefined 或超时 */
export async function pollUntil<T>(
	attempt: () => Promise<T | undefined>,
	timeoutMs: number,
	pollMs: number = POLL_MS,
): Promise<T | undefined> {
	const deadline = Date.now() + Math.max(0, timeoutMs)
	for (;;) {
		const result = await attempt()
		if (result !== undefined) return result
		if (Date.now() >= deadline) return undefined
		await sleep(pollMs)
	}
}

/** 页面区域 DOM 签名（sha1） */
export async function domSignatureOf(page: Page, region = 'body'): Promise<string> {
	const html = await page.evaluate((selector: string) => {
		const el = document.querySelector(selector)
		return el ? el.innerHTML : ''
	}, region)
	return createHash('sha1').update(html).digest('hex')
}

async function textOf(deps: VerifyDeps, target: ElementRef): Promise<string | undefined> {
	try {
		const hit = await deps.resolveTarget(target, { requireVisible: false })
		const text = await hit.locator.textContent({ timeout: 1_000 })
		return (text ?? '').replace(/\s+/g, ' ').trim()
	} catch {
		return undefined
	}
}

async function visibleStateOf(
	deps: VerifyDeps,
	target: ElementRef,
): Promise<{ found: boolean; visible: boolean }> {
	try {
		const hit = await deps.resolveTarget(target, { requireVisible: false })
		const visible = await hit.locator.isVisible()
		return { found: true, visible }
	} catch (err) {
		if (err instanceof ElementNotFoundError) return { found: false, visible: false }
		throw err
	}
}

/** 校验 step.expect；失败抛 StepFailure(EXPECT_MISMATCH) */
export async function verifyExpect(
	deps: VerifyDeps,
	expect: Expect,
	waitMs: number = EXPECT_WAIT_MS,
): Promise<string> {
	switch (expect.kind) {
		case 'urlChange': {
			const re = wildcardToRegExp(expect.pattern)
			try {
				await deps.page.waitForURL(re, { timeout: waitMs })
			} catch {
				// 有些站点用 history.pushState，waitForURL 能捕获；仍失败则再比对一次当前 url
				if (!re.test(deps.page.url())) {
					throw new StepFailure(
						'EXPECT_MISMATCH',
						`urlChange 期望 ${expect.pattern}，实际 ${deps.page.url()}`,
					)
				}
			}
			if (!re.test(deps.page.url())) {
				throw new StepFailure(
					'EXPECT_MISMATCH',
					`urlChange 期望 ${expect.pattern}，实际 ${deps.page.url()}`,
				)
			}
			deps.log(`expect urlChange ✓ ${deps.page.url()}`)
			return `url=${deps.page.url()}`
		}

		case 'elementVisible': {
			const ok = await pollUntil(async () => {
				const state = await visibleStateOf(deps, expect.target)
				return state.found && state.visible ? 'visible' : undefined
			}, waitMs)
			if (ok === undefined) {
				throw new StepFailure(
					'EXPECT_MISMATCH',
					`elementVisible 期望元素在 ${waitMs}ms 内可见，但未出现或仍不可见`,
				)
			}
			deps.log('expect elementVisible ✓')
			return 'visible'
		}

		case 'elementHidden': {
			const ok = await pollUntil(async () => {
				const state = await visibleStateOf(deps, expect.target)
				// 元素从 DOM 消失也算隐藏
				return !state.found || !state.visible ? 'hidden' : undefined
			}, waitMs)
			if (ok === undefined) {
				throw new StepFailure(
					'EXPECT_MISMATCH',
					`elementHidden 期望元素在 ${waitMs}ms 内隐藏，但它始终可见`,
				)
			}
			deps.log('expect elementHidden ✓')
			return 'hidden'
		}

		case 'textChange': {
			const want = expect.to.replace(/\s+/g, ' ').trim()
			const ok = await pollUntil(async () => {
				const text = await textOf(deps, expect.target)
				return text !== undefined && text === want ? text : undefined
			}, waitMs)
			if (ok === undefined) {
				const actual = await textOf(deps, expect.target)
				throw new StepFailure(
					'EXPECT_MISMATCH',
					`textChange 期望 "${want}"，实际 "${actual ?? '<元素不存在>'}"`,
				)
			}
			deps.log(`expect textChange ✓ "${want}"`)
			return `text=${want}`
		}

		case 'domSignature': {
			const ok = await pollUntil(async () => {
				const hash = await domSignatureOf(deps.page, expect.region ?? 'body')
				return hash === expect.hash ? hash : undefined
			}, waitMs)
			if (ok === undefined) {
				const actual = await domSignatureOf(deps.page, expect.region ?? 'body')
				throw new StepFailure(
					'EXPECT_MISMATCH',
					`domSignature 期望 ${expect.hash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
				)
			}
			deps.log('expect domSignature ✓')
			return 'domSignature'
		}

		default: {
			const never: never = expect
			throw new StepFailure('EXPECT_MISMATCH', `未知 expect 类型：${JSON.stringify(never)}`)
		}
	}
}

/** assert 步骤的断言（与 expect 分开：assert 是流程里的显式检查点） */
export async function runAssertion(
	deps: VerifyDeps,
	assertion: Assertion,
	target: ElementRef | undefined,
	waitMs: number = EXPECT_WAIT_MS,
): Promise<string> {
	const needTarget = (): ElementRef => {
		if (!target) throw new StepFailure('EXPECT_MISMATCH', 'assert 缺少 target')
		return target
	}

	switch (assertion.kind) {
		case 'visible': {
			const ref = needTarget()
			const ok = await pollUntil(async () => {
				const state = await visibleStateOf(deps, ref)
				return state.found && state.visible ? 'visible' : undefined
			}, waitMs)
			if (ok === undefined) throw new StepFailure('EXPECT_MISMATCH', 'assert visible 失败：元素不可见')
			return 'visible'
		}
		case 'hidden': {
			const ref = needTarget()
			const ok = await pollUntil(async () => {
				const state = await visibleStateOf(deps, ref)
				return !state.found || !state.visible ? 'hidden' : undefined
			}, waitMs)
			if (ok === undefined) throw new StepFailure('EXPECT_MISMATCH', 'assert hidden 失败：元素仍可见')
			return 'hidden'
		}
		case 'text': {
			const ref = needTarget()
			const wants = { equals: assertion.equals, contains: assertion.contains }
			const ok = await pollUntil(async () => {
				const text = await textOf(deps, ref)
				if (text === undefined) return undefined
				if (wants.equals !== undefined) return text === wants.equals.trim() ? text : undefined
				if (wants.contains !== undefined) {
					return text.includes(wants.contains.trim()) ? text : undefined
				}
				return undefined
			}, waitMs)
			if (ok === undefined) {
				const actual = await textOf(deps, ref)
				throw new StepFailure(
					'EXPECT_MISMATCH',
					`assert text 失败：期望 ${JSON.stringify(wants)}，实际 "${actual ?? '<元素不存在>'}"`,
				)
			}
			return `text=${ok}`
		}
		case 'value': {
			const ref = needTarget()
			const ok = await pollUntil(async () => {
				try {
					const hit = await deps.resolveTarget(ref, { requireVisible: false })
					const value = await hit.locator.inputValue({ timeout: 1_000 })
					return value === assertion.equals ? value : undefined
				} catch {
					return undefined
				}
			}, waitMs)
			if (ok === undefined) throw new StepFailure('EXPECT_MISMATCH', 'assert value 失败：值不匹配')
			return `value=${ok}`
		}
		case 'count': {
			const ref = needTarget()
			const ok = await pollUntil(async () => {
				try {
					const hit = await deps.resolveTarget(ref, { requireVisible: false })
					const count = await hit.locator.count()
					return count === assertion.equals ? count : undefined
				} catch {
					return undefined
				}
			}, waitMs)
			if (ok === undefined) {
				throw new StepFailure('EXPECT_MISMATCH', `assert count 失败：期望 ${assertion.equals}`)
			}
			return `count=${ok}`
		}
		default: {
			const never: never = assertion
			throw new StepFailure('EXPECT_MISMATCH', `未知 assertion：${JSON.stringify(never)}`)
		}
	}
}
