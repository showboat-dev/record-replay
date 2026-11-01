/**
 * expect 推断单测：urlChange / elementVisible / 目标挑选 / URL pattern 生成。
 */
import { describe, expect, it } from 'vitest'

import { appearedNodes, inferExpect, pickExpectTarget, urlPattern } from './expect.js'
import type { ElementRef } from '@rr/schema'
import type { PageSignature, SignatureNode } from './types.js'

function node(overrides: Partial<SignatureNode> & { key: string }): SignatureNode {
	return {
		tag: 'div',
		text: '',
		rect: { x: 0, y: 0, width: 100, height: 40 },
		...overrides,
	}
}

/** 最小合法 ElementRef（只为让 expect 里能塞 target） */
function fakeRef(role: string, name?: string): ElementRef {
	return {
		observed: {
			tag: 'div',
			attributes: {},
			rect: { x: 0, y: 0, width: 100, height: 40 },
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: [{ kind: 'role', value: { role, name }, score: 30, source: 'record' }],
		fingerprint: {
			tag: 'div',
			role,
			accessibleName: name,
			attrs: {},
			stableHash: 'deadbeef',
		},
		frame: { path: [] },
	}
}

function signature(url: string, nodes: SignatureNode[]): PageSignature {
	return { url, nodes }
}

describe('inferExpect', () => {
	it('URL 变化 → urlChange（数字段被吃掉）', () => {
		const result = inferExpect(
			signature('http://127.0.0.1:5173/users', []),
			signature('http://127.0.0.1:5173/users/42', []),
		)
		expect(result).toEqual({ kind: 'urlChange', pattern: 'http://127.0.0.1:5173/users/*' })
	})

	it('URL 不变 + 出现新的可见元素 → elementVisible', () => {
		const target = fakeRef('status', '提交成功')
		const before = signature('http://x/basic', [node({ key: '0:div#1.0|' })])
		const after = signature('http://x/basic', [
			node({ key: '0:div#1.0|' }),
			node({
				key: '0:div#1.0.2|提交成功',
				role: 'status',
				text: '提交成功',
				rect: { x: 10, y: 10, width: 200, height: 60 },
				ref: target,
			}),
		])
		const result = inferExpect(before, after)
		expect(result).toMatchObject({ kind: 'elementVisible' })
		if (result?.kind === 'elementVisible') expect(result.target).toEqual(target)
	})

	it('没有变化 → undefined（宁可不校验也不要造 flaky）', () => {
		const before = signature('http://x/a', [node({ key: '0:div#1|' })])
		const after = signature('http://x/a', [node({ key: '0:div#1|' })])
		expect(inferExpect(before, after)).toBeUndefined()
	})

	it('新元素没有 ref（未挑中）→ 不出 expect', () => {
		const before = signature('http://x/a', [])
		const after = signature('http://x/a', [node({ key: '0:p#0|新文本', role: 'status', text: '新文本' })])
		expect(inferExpect(before, after)).toBeUndefined()
	})

	it('URL 变化优先于元素变化', () => {
		const target = fakeRef('status', 'ok')
		const before = signature('http://x/a', [])
		const after = signature('http://x/b', [node({ key: '0:p#0|ok', text: 'ok', ref: target })])
		expect(inferExpect(before, after)?.kind).toBe('urlChange')
	})
})

describe('appearedNodes', () => {
	it('只返回 after 独有的 key', () => {
		const before = signature('u', [node({ key: 'a' }), node({ key: 'b' })])
		const after = signature('u', [node({ key: 'a' }), node({ key: 'c' })])
		expect(appearedNodes(before, after).map((n) => n.key)).toEqual(['c'])
	})
})

describe('pickExpectTarget', () => {
	it('优先 role=status/alert 的节点', () => {
		const picked = pickExpectTarget([
			node({ key: 'a', tag: 'div', role: undefined, text: 'x', rect: { x: 0, y: 0, width: 10, height: 10 } }),
			node({ key: 'b', role: 'alert', text: 'y', rect: { x: 0, y: 0, width: 500, height: 300 } }),
		])
		expect(picked?.key).toBe('b')
	})

	it('同等条件下挑面积小的（更像「具体反馈」而不是整块容器）', () => {
		const picked = pickExpectTarget([
			node({ key: 'big', text: 'ok', rect: { x: 0, y: 0, width: 1200, height: 800 } }),
			node({ key: 'small', text: 'ok', rect: { x: 0, y: 0, width: 120, height: 40 } }),
		])
		expect(picked?.key).toBe('small')
	})

	it('空列表 → undefined', () => {
		expect(pickExpectTarget([])).toBeUndefined()
	})
})

describe('urlPattern', () => {
	it('数字 / uuid / 十六进制段变 *', () => {
		expect(urlPattern('http://h/users/42/orders/550e8400-e29b-41d4-a716-446655440000')).toBe(
			'http://h/users/*/orders/*',
		)
	})

	it('日期样式段也变 *', () => {
		expect(urlPattern('http://h/report/2024-01-02')).toBe('http://h/report/*')
	})

	it('有 query → 只保留形状', () => {
		expect(urlPattern('http://h/search?q=abc&page=2')).toBe('http://h/search?*')
	})

	it('丢弃 hash，保留普通路径段', () => {
		expect(urlPattern('http://h/docs/intro#top')).toBe('http://h/docs/intro')
	})

	it('非法 URL 原样返回', () => {
		expect(urlPattern('not a url')).toBe('not a url')
	})
})
