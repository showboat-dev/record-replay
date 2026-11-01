import { describe, expect, it } from 'vitest'

import { matchesUrlPattern, rebaseUrl, wildcardToRegExp } from './index.js'

describe('resolver: wildcardToRegExp', () => {
	it('`*` 通配、`?` 单字符，其余字符按字面量', () => {
		expect(wildcardToRegExp('**/inner-form').test('http://a:111/inner-form')).toBe(true)
		expect(wildcardToRegExp('/basic').test('/basic')).toBe(true)
		expect(wildcardToRegExp('/basic').test('/basic2')).toBe(true) // 子串匹配，调用方负责精确断言
		expect(wildcardToRegExp('a?c').test('abc')).toBe(true)
	})

	it('正则元字符被转义（不会把 . 当通配）', () => {
		expect(wildcardToRegExp('a.b').test('axb')).toBe(false)
		expect(wildcardToRegExp('a.b').test('a.b')).toBe(true)
	})
})

describe('resolver: frame urlPattern 跨环境匹配', () => {
	it('录制端口 5199 → 回放端口 5173：完整 URL 被重定基后匹配', () => {
		const pattern = 'http://127.0.0.1:5199/inner-form'
		const baseUrl = 'http://127.0.0.1:5173'
		expect(rebaseUrl(pattern, baseUrl)).toBe('http://127.0.0.1:5173/inner-form')
		expect(
			matchesUrlPattern('http://127.0.0.1:5173/inner-form', pattern, baseUrl, wildcardToRegExp),
		).toBe(true)
	})

	it('baseUrl 缺失时，靠 pathname 兜底仍能匹配（origin 不同也能进 frame）', () => {
		const pattern = 'http://127.0.0.1:5199/inner-form'
		expect(
			matchesUrlPattern('http://127.0.0.1:9999/inner-form', pattern, undefined, wildcardToRegExp),
		).toBe(true)
		expect(
			matchesUrlPattern('http://127.0.0.1:9999/other', pattern, undefined, wildcardToRegExp),
		).toBe(false)
	})

	it('相对 path 的 pattern 也能匹配', () => {
		expect(matchesUrlPattern('http://x.test:1/inner-form?a=1', '/inner-*', undefined, wildcardToRegExp)).toBe(
			true,
		)
	})
})
