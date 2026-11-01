import { describe, expect, it } from 'vitest'

import { rebaseUrl } from './index.js'

describe('executor: baseUrl 重定基（只换 origin）', () => {
	it('绝对 URL：只换 origin，path/query/hash 原样保留', () => {
		expect(rebaseUrl('http://a:111/x?q=1', 'http://b:222')).toBe('http://b:222/x?q=1')
		expect(rebaseUrl('http://a:111/x?q=1#frag', 'http://b:222')).toBe(
			'http://b:222/x?q=1#frag',
		)
		expect(rebaseUrl('https://old.example.com/deep/path', 'http://127.0.0.1:5173')).toBe(
			'http://127.0.0.1:5173/deep/path',
		)
	})

	it('baseUrl 带尾部斜杠也不产生双斜杠', () => {
		expect(rebaseUrl('http://a:111/x', 'http://b:222/')).toBe('http://b:222/x')
	})

	it('baseUrl 为空/未设置 → 原样返回（录制 URL 不变）', () => {
		const url = 'http://a:111/x?q=1'
		expect(rebaseUrl(url, undefined)).toBe(url)
		expect(rebaseUrl(url, '')).toBe(url)
		expect(rebaseUrl(url, '   ')).toBe(url)
	})

	it('baseUrl 非法 → 回退原 URL（不抛、不拼怪串）', () => {
		expect(rebaseUrl('http://a:111/x', 'not a url')).toBe('http://a:111/x')
	})

	it('相对 URL → 按 baseUrl 解析', () => {
		expect(rebaseUrl('/x?q=1', 'http://b:222')).toBe('http://b:222/x?q=1')
	})

	it('root path 与默认端口都正确处理', () => {
		expect(rebaseUrl('http://a:111/', 'http://b:222')).toBe('http://b:222/')
		expect(rebaseUrl('http://a/basic', 'https://staging.example.com')).toBe(
			'https://staging.example.com/basic',
		)
	})
})

describe('executor: matchesUrlPattern（frame urlPattern 跨环境）', () => {
	it('pathname 兜底：端口不同也能匹配（staging → prod 场景）', async () => {
		const { matchesUrlPattern, wildcardToRegExp } = await import('@rr/resolver')
		expect(
			matchesUrlPattern(
				'https://prod.example.com/inner-form',
				'https://staging.example.com/inner-form',
				undefined,
				wildcardToRegExp,
			),
		).toBe(true)
	})
})
