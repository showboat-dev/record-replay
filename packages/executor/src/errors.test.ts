import { ElementNotFoundError } from '@rr/resolver'
import { describe, expect, it } from 'vitest'

import { classifyError, StepFailure, TemplateError } from './index.js'
import { makeRef } from './testUtils.js'

const ref = makeRef()

describe('executor: 失败归类（不允许裸 timeout）', () => {
	it('Resolver NO_MATCH / AMBIGUOUS → ELEMENT_NOT_FOUND', () => {
		const noMatch = new ElementNotFoundError('NO_MATCH', ref, '找不到')
		expect(classifyError(noMatch, 'resolve')).toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
		const ambiguous = new ElementNotFoundError('AMBIGUOUS', ref, '歧义')
		expect(classifyError(ambiguous, 'resolve')).toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
	})

	it('Resolver HIDDEN → NOT_ACTIONABLE（存在但不可交互）', () => {
		const hidden = new ElementNotFoundError('HIDDEN', ref, '不可见')
		const out = classifyError(hidden, 'resolve')
		expect(out.code).toBe('NOT_ACTIONABLE')
		expect(out.message).toContain('HIDDEN')
	})

	it('StepFailure 的错误码原样透传（NO_EFFECT / EXPECT_MISMATCH / DIALOG_UNEXPECTED）', () => {
		expect(classifyError(new StepFailure('NO_EFFECT', '无变化'), 'action').code).toBe('NO_EFFECT')
		expect(classifyError(new StepFailure('EXPECT_MISMATCH', '不匹配'), 'expect').code).toBe(
			'EXPECT_MISMATCH',
		)
		expect(classifyError(new StepFailure('DIALOG_UNEXPECTED', '弹窗'), 'action').code).toBe(
			'DIALOG_UNEXPECTED',
		)
	})

	it('TemplateError → VARIABLE_MISSING，且信息带变量名', () => {
		const out = classifyError(new TemplateError('缺少变量 "email"', 'email'), 'template')
		expect(out.code).toBe('VARIABLE_MISSING')
		expect(out.message).toContain('email')
	})

	it('浏览器崩溃 / 连接断开 → BROWSER_CRASH', () => {
		expect(
			classifyError(new Error('Target page, context or browser has been closed'), 'action').code,
		).toBe('BROWSER_CRASH')
		expect(classifyError(new Error('Browser has been closed'), 'action').code).toBe('BROWSER_CRASH')
		expect(classifyError(new Error('Page crashed!'), 'framework').code).toBe('BROWSER_CRASH')
	})

	it('网络类错误 → NAVIGATION_FAILED', () => {
		expect(
			classifyError(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at http://nope'), 'navigate')
				.code,
		).toBe('NAVIGATION_FAILED')
		expect(classifyError(new Error('NS_ERROR_UNKNOWN_HOST'), 'action').code).toBe('NAVIGATION_FAILED')
	})

	it('Playwright actionability 关键词 → NOT_ACTIONABLE', () => {
		expect(
			classifyError(
				new Error('locator.click: Timeout 15000ms exceeded. <div> intercepts pointer events'),
				'action',
			).code,
		).toBe('NOT_ACTIONABLE')
		expect(
			classifyError(new Error('element is not stable, retrying'), 'action').code,
		).toBe('NOT_ACTIONABLE')
		expect(
			classifyError(new Error('strict mode violation: locator resolved to 3 elements'), 'action')
				.code,
		).toBe('NOT_ACTIONABLE')
	})

	it('同一个 timeout 按阶段解释（不留下裸 timeout）', () => {
		const timeout = new Error('Timeout 30000ms exceeded.')
		expect(classifyError(timeout, 'navigate').code).toBe('NAVIGATION_FAILED')
		expect(classifyError(timeout, 'expect').code).toBe('EXPECT_MISMATCH')
		expect(classifyError(timeout, 'resolve').code).toBe('ELEMENT_NOT_FOUND')
		expect(classifyError(timeout, 'action').code).toBe('NOT_ACTIONABLE')
	})

	it('未知错误按阶段给默认码，永远有码', () => {
		const weird = new Error('something unexpected')
		expect(classifyError(weird, 'resolve').code).toBe('ELEMENT_NOT_FOUND')
		expect(classifyError(weird, 'expect').code).toBe('EXPECT_MISMATCH')
		expect(classifyError(weird, 'navigate').code).toBe('NAVIGATION_FAILED')
		expect(classifyError(weird, 'action').code).toBe('NOT_ACTIONABLE')
		expect(classifyError(weird, 'framework').code).toBe('BROWSER_CRASH')
	})

	it('AI aria-ref 失效（导航后）→ ELEMENT_NOT_FOUND，且标注可重试', () => {
		const out = classifyError(
			new Error('locator.count: Invalid frame in aria-ref selector "aria-ref=f2e1"'),
			'resolve',
		)
		expect(out.code).toBe('ELEMENT_NOT_FOUND')
		expect(out.message).toContain('重新快照')
	})

	it('非 Error 值也能归类（不抛）', () => {
		expect(classifyError('boom', 'action').code).toBe('NOT_ACTIONABLE')
		expect(classifyError({ hello: 1 }, 'action').message).toContain('hello')
	})
})
