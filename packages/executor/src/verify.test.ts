import type { Page } from 'playwright'
import type { ResolveResult } from '@rr/resolver'
import { ElementNotFoundError } from '@rr/resolver'
import { describe, expect, it, vi } from 'vitest'

import { pollUntil, runAssertion, verifyExpect, type VerifyDeps } from './index.js'
import { StepFailure } from './index.js'
import { makeRef } from './testUtils.js'

const ref = makeRef()

function fakePage(overrides: Partial<Page> = {}): Page {
	const base = {
		url: () => 'http://x.test/basic',
		waitForURL: async () => undefined,
	} as unknown as Page
	return Object.assign(base, overrides) as Page
}

function fakeHit(
	options: { visible?: boolean; text?: string; value?: string; count?: number } = {},
): ResolveResult {
	const locator = {
		isVisible: async () => options.visible ?? true,
		textContent: async () => options.text ?? '',
		inputValue: async () => options.value ?? '',
		count: async () => options.count ?? 1,
	} as unknown as ResolveResult['locator']
	return { locator, level: 'L1', score: 100, ambiguous: false }
}

function deps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
	return {
		page: fakePage(),
		timeoutMs: 1_000,
		log: () => {},
		resolveTarget: async () => fakeHit(),
		...overrides,
	}
}

describe('executor: pollUntil', () => {
	it('第一次就成功 → 直接返回', async () => {
		let calls = 0
		const value = await pollUntil(async () => {
			calls += 1
			return 'ok'
		}, 500)
		expect(value).toBe('ok')
		expect(calls).toBe(1)
	})

	it('重试后成功', async () => {
		let calls = 0
		const value = await pollUntil(
			async () => {
				calls += 1
				return calls >= 3 ? 'late' : undefined
			},
			2_000,
			10,
		)
		expect(value).toBe('late')
		expect(calls).toBeGreaterThanOrEqual(3)
	})

	it('超时返回 undefined', async () => {
		const value = await pollUntil(async () => undefined, 60, 10)
		expect(value).toBeUndefined()
	})
})

describe('executor: expect 判定', () => {
	it('urlChange 通过（通配 → 正则）', async () => {
		const note = await verifyExpect(deps(), { kind: 'urlChange', pattern: '**/basic' }, 200)
		expect(note).toContain('http://x.test/basic')
	})

	it('urlChange 不匹配 → EXPECT_MISMATCH，且信息里有实际 url', async () => {
		const d = deps({ page: fakePage({ url: () => 'http://x.test/other' }) })
		await expect(verifyExpect(d, { kind: 'urlChange', pattern: '**/basic' }, 200)).rejects.toThrow(
			StepFailure,
		)
		try {
			await verifyExpect(d, { kind: 'urlChange', pattern: '**/basic' }, 200)
		} catch (err) {
			expect((err as StepFailure).code).toBe('EXPECT_MISMATCH')
			expect((err as StepFailure).message).toContain('http://x.test/other')
		}
	})

	it('elementVisible 通过', async () => {
		await expect(verifyExpect(deps(), { kind: 'elementVisible', target: ref }, 200)).resolves.toBe(
			'visible',
		)
	})

	it('elementVisible 一直不可见 → EXPECT_MISMATCH', async () => {
		const d = deps({ resolveTarget: async () => fakeHit({ visible: false }) })
		await expect(
			verifyExpect(d, { kind: 'elementVisible', target: ref }, 120),
		).rejects.toMatchObject({ code: 'EXPECT_MISMATCH' })
	})

	it('elementHidden：元素从 DOM 消失也算隐藏', async () => {
		const d = deps({
			resolveTarget: async () => {
				throw new ElementNotFoundError('NO_MATCH', ref, '找不到')
			},
		})
		await expect(verifyExpect(d, { kind: 'elementHidden', target: ref }, 200)).resolves.toBe(
			'hidden',
		)
	})

	it('elementHidden：仍然可见 → EXPECT_MISMATCH', async () => {
		const d = deps({ resolveTarget: async () => fakeHit({ visible: true }) })
		await expect(
			verifyExpect(d, { kind: 'elementHidden', target: ref }, 120),
		).rejects.toMatchObject({ code: 'EXPECT_MISMATCH' })
	})

	it('textChange 通过 / 不匹配', async () => {
		const ok = deps({ resolveTarget: async () => fakeHit({ text: '  提交成功  ' }) })
		await expect(
			verifyExpect(ok, { kind: 'textChange', target: ref, to: '提交成功' }, 200),
		).resolves.toContain('提交成功')

		const bad = deps({ resolveTarget: async () => fakeHit({ text: '失败' }) })
		await expect(
			verifyExpect(bad, { kind: 'textChange', target: ref, to: '提交成功' }, 120),
		).rejects.toMatchObject({ code: 'EXPECT_MISMATCH' })
	})
})

describe('executor: assert 断言', () => {
	it('visible 通过', async () => {
		await expect(runAssertion(deps(), { kind: 'visible' }, ref, 200)).resolves.toBe('visible')
	})

	it('visible 不可见 → EXPECT_MISMATCH', async () => {
		const d = deps({ resolveTarget: async () => fakeHit({ visible: false }) })
		await expect(runAssertion(d, { kind: 'visible' }, ref, 120)).rejects.toMatchObject({
			code: 'EXPECT_MISMATCH',
		})
	})

	it('缺少 target → 明确报错', async () => {
		await expect(runAssertion(deps(), { kind: 'visible' }, undefined, 100)).rejects.toThrow(
			/缺少 target/,
		)
	})

	it('text equals 通过 / contains 通过', async () => {
		const d = deps({ resolveTarget: async () => fakeHit({ text: '提交成功（第 1 次）' }) })
		await expect(
			runAssertion(d, { kind: 'text', contains: '提交成功' }, ref, 200),
		).resolves.toContain('提交成功')
		await expect(
			runAssertion(d, { kind: 'text', equals: '提交成功（第 1 次）' }, ref, 200),
		).resolves.toContain('提交成功')
	})

	it('value 通过', async () => {
		const d = deps({ resolveTarget: async () => fakeHit({ value: '张三' }) })
		await expect(runAssertion(d, { kind: 'value', equals: '张三' }, ref, 200)).resolves.toBe(
			'value=张三',
		)
	})

	it('count 不匹配 → EXPECT_MISMATCH', async () => {
		const d = deps({ resolveTarget: async () => fakeHit({ count: 3 }) })
		await expect(runAssertion(d, { kind: 'count', equals: 1 }, ref, 120)).rejects.toMatchObject({
			code: 'EXPECT_MISMATCH',
		})
	})

	it('期望命中后写 log（可观测）', async () => {
		const log = vi.fn()
		const d = deps({ log })
		await verifyExpect(d, { kind: 'elementVisible', target: ref }, 200)
		expect(log).toHaveBeenCalled()
	})
})
