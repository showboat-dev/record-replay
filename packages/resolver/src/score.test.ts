import { describe, expect, it } from 'vitest'

import {
	AMBIGUITY_THRESHOLD,
	centerDistance,
	geometryScore,
	isAmbiguous,
	pickWinner,
	rankMatches,
	rectIou,
} from './index.js'

const rect = (x: number, y: number, width = 100, height = 20) => ({ x, y, width, height })
const viewport = { width: 1440, height: 900 }

describe('resolver: 几何打分', () => {
	it('完全相同的矩形 → IoU 1、几何分 100', () => {
		expect(rectIou(rect(10, 10), rect(10, 10))).toBe(1)
		expect(geometryScore(rect(10, 10), rect(10, 10), viewport)).toBe(100)
	})

	it('不相交且很远 → 分数显著低于相同矩形', () => {
		const near = geometryScore(rect(10, 10), rect(12, 12), viewport)
		const far = geometryScore(rect(10, 10), rect(900, 700), viewport)
		expect(near).toBeGreaterThan(far)
		expect(far).toBeLessThan(50)
	})

	it('centerDistance 用中心点，而非左上角', () => {
		expect(centerDistance(rect(0, 0), rect(100, 0))).toBe(100)
		expect(centerDistance(rect(0, 0), rect(0, 0))).toBe(0)
	})

	it('零面积矩形 IoU 记 0（不产生 NaN）', () => {
		expect(rectIou(rect(0, 0, 0, 0), rect(0, 0))).toBe(0)
		expect(Number.isFinite(geometryScore(rect(0, 0, 0, 0), rect(0, 0), viewport))).toBe(true)
	})

	it('rankMatches 按分数降序，缺 rect 的排最后', () => {
		const items = [
			{ id: 'far', box: rect(900, 700) as ReturnType<typeof rect> | undefined },
			{ id: 'exact', box: rect(10, 10) },
			{ id: 'nobox', box: undefined },
		]
		const ranked = rankMatches(items, (it) => it.box, rect(10, 10), viewport)
		expect(ranked.map((r) => r.item.id)).toEqual(['exact', 'far', 'nobox'])
		expect(ranked[2]?.score).toBe(0)
	})
})

describe('resolver: 歧义判定（计划硬性：分差 < 15% 不猜）', () => {
	it('阈值常量是 0.15', () => {
		expect(AMBIGUITY_THRESHOLD).toBe(0.15)
	})

	it('两个完全同分 → 歧义', () => {
		expect(isAmbiguous([80, 80])).toBe(true)
	})

	it('分差 10% < 15% → 歧义', () => {
		expect(isAmbiguous([100, 90])).toBe(true)
	})

	it('分差 14.9% → 歧义（边界内）', () => {
		expect(isAmbiguous([100, 85.1])).toBe(true)
	})

	it('分差刚好 15% → 不歧义（判定用 <）', () => {
		expect(isAmbiguous([100, 85])).toBe(false)
	})

	it('分差 40% → 不歧义', () => {
		expect(isAmbiguous([100, 60])).toBe(false)
	})

	it('两个都是 0 分 → 歧义（无法区分）', () => {
		expect(isAmbiguous([0, 0])).toBe(true)
	})

	it('只有一个候选 → 不歧义', () => {
		expect(isAmbiguous([42])).toBe(false)
		expect(isAmbiguous([])).toBe(false)
	})

	it('pickWinner：唯一高分给 winner，并列给 runnersUp', () => {
		const clear = pickWinner([
			{ item: 'a', score: 100 },
			{ item: 'b', score: 50 },
		])
		expect(clear.ambiguous).toBe(false)
		expect(clear.winner?.item).toBe('a')

		const tied = pickWinner([
			{ item: 'a', score: 90 },
			{ item: 'b', score: 88 },
		])
		expect(tied.ambiguous).toBe(true)
		expect(tied.winner).toBeUndefined()
		expect(tied.runnersUp.map((r) => r.item)).toEqual(['a', 'b'])
	})

	it('pickWinner：空集合不报歧义也不给 winner', () => {
		const empty = pickWinner([])
		expect(empty).toEqual({ ambiguous: false, runnersUp: [] })
	})
})
