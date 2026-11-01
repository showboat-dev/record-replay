/**
 * L1：语义候选逐个尝试。
 *
 * 契约（docs/architecture.md §4）：
 * - 按 candidates 顺序（score 升序）逐个尝试，要求 `count()===1 && isVisible()`；
 * - 多命中时按「候选顺序 + 几何距离」排序；
 * - top1/top2 相对分差 < 15% → ambiguous，**不猜**，继续降级；
 * - 唯一命中但不可见 → 记为 HIDDEN（executor 会归类成 NOT_ACTIONABLE）。
 */
import type { Candidate, ElementRef, Rect } from '@rr/schema'
import type { Locator } from 'playwright'

import { candidateLocator, describeCandidate } from './candidates.js'
import { ElementNotFoundError } from './errors.js'
import { pickWinner, rankMatches } from './score.js'
import { sortCandidates, type Scope } from './types.js'

export interface L1Options {
	requireVisible: boolean
	ambiguityThreshold: number
}

export interface L1Hit {
	locator: Locator
	score: number
	candidate: Candidate
	matchedCount: number
}

export interface L1Failure {
	/** 所有候选都 0 命中 */
	noMatch: boolean
	/** 命中过多个且分差不足 */
	sawAmbiguous: boolean
	/** 命中过唯一但不可见 */
	sawHidden: boolean
	detail: string[]
}

/** 从页面取所有匹配元素的视口矩形（一次 evaluate，避免 N 次 boundingBox） */
async function rectsOf(locator: Locator): Promise<Rect[]> {
	return locator.evaluateAll((els) =>
		els.map((el) => {
			const r = el.getBoundingClientRect()
			return { x: r.x, y: r.y, width: r.width, height: r.height }
		}),
	)
}

export async function resolveL1(
	target: ElementRef,
	scope: Scope,
	opts: L1Options,
	log: (msg: string) => void,
): Promise<L1Hit> {
	const candidates = sortCandidates(target.candidates)
	const failure: L1Failure = { noMatch: true, sawAmbiguous: false, sawHidden: false, detail: [] }
	const observed = target.observed.rect
	const viewport = target.observed.viewport

	if (candidates.length === 0) {
		throw new ElementNotFoundError('INVALID_REF', target, 'ElementRef.candidates 为空')
	}

	for (const candidate of candidates) {
		const label = describeCandidate(candidate)
		let locator: Locator
		try {
			locator = candidateLocator(scope, candidate)
		} catch (err) {
			// 单条候选不合法不该让整次解析失败，记录下来试下一条
			failure.detail.push(`${label}: 构造 locator 失败（${(err as Error).message}）`)
			continue
		}

		let count: number
		try {
			count = await locator.count()
		} catch (err) {
			failure.detail.push(`${label}: count() 失败（${(err as Error).message}）`)
			continue
		}

		if (count === 0) {
			failure.detail.push(`${label}: 0 命中`)
			log(`L1 ${label} → 0 命中`)
			continue
		}
		failure.noMatch = false

		if (count === 1) {
			const visible = await locator.isVisible()
			if (visible || !opts.requireVisible) {
				log(`L1 ${label} → 唯一命中${visible ? '' : '（可见性未校验）'}`)
				return { locator, score: 100, candidate, matchedCount: 1 }
			}
			failure.sawHidden = true
			failure.detail.push(`${label}: 唯一命中但不可见`)
			log(`L1 ${label} → 命中但不可见`)
			continue
		}

		// 多命中：几何打分 + 歧义判定
		let rects: Rect[]
		try {
			rects = await rectsOf(locator)
		} catch (err) {
			failure.detail.push(`${label}: 取矩形失败（${(err as Error).message}）`)
			continue
		}
		const indexed = rects.map((rect, index) => ({ index, rect }))
		const ranked = rankMatches(indexed, (it) => it.rect, observed, viewport)
		const picked = pickWinner(ranked, opts.ambiguityThreshold)
		const top = ranked[0]

		if (picked.ambiguous) {
			failure.sawAmbiguous = true
			const [a, b] = picked.runnersUp
			failure.detail.push(
				`${label}: ${count} 命中且 top1/top2 分差不足 15%` +
					`（${a?.score ?? 0} vs ${b?.score ?? 0}）`,
			)
			log(`L1 ${label} → ${count} 命中，歧义（${a?.score ?? 0} vs ${b?.score ?? 0}），降级`)
			continue
		}
		if (!picked.winner || !top) {
			failure.detail.push(`${label}: ${count} 命中但无法排序`)
			continue
		}

		const winnerLocator = locator.nth(picked.winner.item.index)
		const visible = await winnerLocator.isVisible()
		if (!visible && opts.requireVisible) {
			failure.sawHidden = true
			failure.detail.push(`${label}: 多命中中几何最优者不可见（score=${picked.winner.score}）`)
			continue
		}
		log(`L1 ${label} → ${count} 命中，几何最优 score=${picked.winner.score}`)
		return {
			locator: winnerLocator,
			score: picked.winner.score,
			candidate,
			matchedCount: count,
		}
	}

	const code = failure.sawAmbiguous ? 'AMBIGUOUS' : failure.sawHidden ? 'HIDDEN' : 'NO_MATCH'
	const head =
		code === 'AMBIGUOUS'
			? '所有候选都无法唯一确定元素（top1/top2 分差 < 15%，拒绝猜测）'
			: code === 'HIDDEN'
				? '命中了元素但不可见/不可交互'
				: '所有语义候选均未命中'
	throw new ElementNotFoundError(code, target, head, {
		level: 'L1',
		candidates: candidates.map(describeCandidate),
		detail: failure.detail,
	})
}
