/**
 * 多命中打分 + 歧义判定（纯函数，可单测）。
 *
 * 计划里定死的规则：
 * - 候选顺序优先（同一个候选内部候选权重相同，所以比较只在几何维度上有意义）；
 * - top1 与 top2 的**相对分差** < 15% → ambiguous，不猜，降级。
 */
import type { Rect } from '@rr/schema'

/** 相对分差阈值：0.15 = 15% */
export const AMBIGUITY_THRESHOLD = 0.15

export interface ViewportSize {
	width: number
	height: number
}

export interface Scored<T> {
	item: T
	score: number
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0
	if (n < 0) return 0
	if (n > 1) return 1
	return n
}

export function rectArea(r: Rect): number {
	return Math.max(0, r.width) * Math.max(0, r.height)
}

/** 交并比，0..1 */
export function rectIou(a: Rect, b: Rect): number {
	const x1 = Math.max(a.x, b.x)
	const y1 = Math.max(a.y, b.y)
	const x2 = Math.min(a.x + a.width, b.x + b.width)
	const y2 = Math.min(a.y + a.height, b.y + b.height)
	const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
	const union = rectArea(a) + rectArea(b) - inter
	if (union <= 0) return 0
	return clamp01(inter / union)
}

/** 两矩形中心点距离（CSS px） */
export function centerDistance(a: Rect, b: Rect): number {
	const ax = a.x + a.width / 2
	const ay = a.y + a.height / 2
	const bx = b.x + b.width / 2
	const by = b.y + b.height / 2
	return Math.hypot(ax - bx, ay - by)
}

/**
 * 几何相似度 0..100。
 * IoU 权重 0.6（尺寸形状吻合），中心距离权重 0.4（位置吻合，按视口对角线归一化）。
 */
export function geometryScore(observed: Rect, rect: Rect, viewport: ViewportSize): number {
	const iou = rectIou(observed, rect)
	const diagonal = Math.hypot(Math.max(1, viewport.width), Math.max(1, viewport.height))
	const proximity = clamp01(1 - centerDistance(observed, rect) / diagonal)
	return Math.round((iou * 0.6 + proximity * 0.4) * 1000) / 10
}

/**
 * 按几何相似度降序排序；没有 rect 的匹配项排最后（score 0）。
 * 排序稳定：同分保持输入顺序（= DOM 顺序 / 候选顺序）。
 */
export function rankMatches<T>(
	items: T[],
	rectOf: (item: T) => Rect | undefined,
	observed: Rect,
	viewport: ViewportSize,
): Scored<T>[] {
	const scored: Scored<T>[] = items.map((item) => {
		const rect = rectOf(item)
		return { item, score: rect ? geometryScore(observed, rect, viewport) : 0 }
	})
	// Array.prototype.sort 在 V8 上是稳定排序，同分保留 DOM 顺序
	return scored.sort((a, b) => b.score - a.score)
}

/**
 * top1/top2 相对分差 < threshold → 歧义。
 * 注意 s1===s2 属于最典型的歧义（分差 0）。
 */
export function isAmbiguous(scores: number[], threshold: number = AMBIGUITY_THRESHOLD): boolean {
	const s1 = scores[0]
	if (s1 === undefined) return false
	const s2 = scores[1]
	if (s2 === undefined) return false
	const base = Math.abs(s1)
	if (base < 1e-9) return true // 两个都是 0 分：完全无法区分
	return (s1 - s2) / base < threshold
}

export interface PickResult<T> {
	/** 唯一胜出者；歧义或空集合时为 undefined */
	winner?: Scored<T>
	ambiguous: boolean
	/** 歧义时给出并列前两名，便于日志/artifact 说明"为什么没敢点" */
	runnersUp: Scored<T>[]
}

/** 从已排序的匹配里挑唯一胜者 */
export function pickWinner<T>(
	ranked: Scored<T>[],
	threshold: number = AMBIGUITY_THRESHOLD,
): PickResult<T> {
	const first = ranked[0]
	if (!first) return { ambiguous: false, runnersUp: [] }
	const scores = ranked.slice(0, 2).map((s) => s.score)
	if (isAmbiguous(scores, threshold)) {
		return { ambiguous: true, runnersUp: ranked.slice(0, 2) }
	}
	return { winner: first, ambiguous: false, runnersUp: ranked.slice(0, 2) }
}
