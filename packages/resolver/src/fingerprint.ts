/**
 * L2：stableHash 指纹精确匹配。
 *
 * 流程（计划里定死的）：
 *   page.evaluate 内按指纹字段筛元素 → 命中者打 `data-rr-target=<uid>` →
 *   Node 侧用候选 uid 转 Locator → action 结束后由 `release()` 删除标记。
 *
 * 为什么标记要留到 action 之后才删：Locator 是靠这个属性定位的，
 * resolve 返回后立刻删会让 locator 失效。`release` 由 executor 在 finally 调用；
 * 即使调用方忘了，下一次 L2 采集开头也会把历史标记全部清掉（自愈）。
 *
 * 两级匹配策略：
 *   hash  —— 用 Node 侧 computeStableHash 重算候选指纹，要求与 flow 里的 stableHash 完全相等（主路径）；
 *   attrs —— hash 对不上（例如 flow 由别的算法录制）时，退化为「tag+role+name+录制属性全等」，
 *            依然是**精确相等**判断，不做相似度打分，也不做 nodePath 容错（按计划 M1 不做）。
 */
import type { ElementRef } from '@rr/schema'
import type { Locator } from 'playwright'

import { ElementNotFoundError } from './errors.js'
import {
	collectFingerprintCandidates,
	computeStableHash,
	removeFingerprintMarkers,
	STABLE_ATTR_POLICY,
	type InPageCandidate,
} from './hash.js'
import { pickWinner, rankMatches } from './score.js'
import type { Scope } from './types.js'

export const L2_MARKER = 'data-rr-target'

export interface L2Options {
	requireVisible: boolean
	ambiguityThreshold: number
	maxFingerprintMatches: number
}

export interface L2Hit {
	locator: Locator
	score: number
	strategy: 'hash' | 'attrs'
	matched: number
	release: () => Promise<void>
}

export async function resolveL2(
	target: ElementRef,
	scope: Scope,
	opts: L2Options,
	log: (msg: string) => void,
): Promise<L2Hit> {
	const fingerprint = target.fingerprint
	let candidates: InPageCandidate[] = []

	const strip = async (): Promise<void> => {
		try {
			await scope.evaluate(removeFingerprintMarkers, { marker: L2_MARKER })
		} catch {
			/* 页面可能已经跳走/关闭，清理失败不影响主流程 */
		}
	}

	try {
		candidates = await scope.evaluate(collectFingerprintCandidates, {
			policy: STABLE_ATTR_POLICY,
			tag: fingerprint.tag,
			role: fingerprint.role,
			name: fingerprint.accessibleName,
			attrs: fingerprint.attrs,
			marker: L2_MARKER,
			limit: opts.maxFingerprintMatches,
		})
	} catch (err) {
		throw new ElementNotFoundError('NO_MATCH', target, 'L2 页面内指纹采集失败', {
			level: 'L2',
			cause: (err as Error).message,
		})
	}

	if (candidates.length === 0) {
		await strip()
		throw new ElementNotFoundError('NO_MATCH', target, 'L2 指纹未在页面中找到任何匹配元素', {
			level: 'L2',
			fingerprint: {
				tag: fingerprint.tag,
				role: fingerprint.role,
				accessibleName: fingerprint.accessibleName,
				attrs: fingerprint.attrs,
			},
		})
	}

	// 主路径：stableHash 精确相等。
	// recorder 的 hash 把 nodePath 也算进去了（用于区分「两个一模一样的按钮」），
	// 所以指纹里有 nodePath 时，用页面内现场算出的 nodePath 参与哈希；否则不带 path。
	const useNodePath = fingerprint.nodePath !== undefined
	const exact = candidates.filter((c) => {
		const hash = computeStableHash({
			tag: c.tag,
			role: c.role,
			accessibleName: c.name,
			attrs: c.attrs,
			...(useNodePath ? { nodePath: c.nodePath } : {}),
		})
		return hash === fingerprint.stableHash
	})
	const strategy: 'hash' | 'attrs' = exact.length > 0 ? 'hash' : 'attrs'
	const pool = exact.length > 0 ? exact : candidates
	if (strategy === 'attrs') {
		log(
			`L2 stableHash 未命中（flow 里 ${fingerprint.stableHash.slice(0, 8)}…），` +
				`退化到指纹字段全等匹配（${candidates.length} 个候选）`,
		)
	}

	const observed = target.observed.rect
	const viewport = target.observed.viewport
	const ranked = rankMatches(pool, (c) => c.rect, observed, viewport)
	const picked = pickWinner(ranked, opts.ambiguityThreshold)

	if (picked.ambiguous) {
		await strip()
		const [a, b] = picked.runnersUp
		throw new ElementNotFoundError('AMBIGUOUS', target, 'L2 指纹命中多个元素且几何分差不足 15%', {
			level: 'L2',
			strategy,
			scores: [a?.score ?? 0, b?.score ?? 0],
			matched: pool.length,
		})
	}

	const winner = picked.winner
	if (!winner) {
		await strip()
		throw new ElementNotFoundError('NO_MATCH', target, 'L2 指纹候选无法排序', {
			level: 'L2',
			strategy,
		})
	}

	const locator = scope.locator(`[${L2_MARKER}="${winner.item.uid}"]`)
	const count = await locator.count()
	if (count !== 1) {
		await strip()
		throw new ElementNotFoundError('AMBIGUOUS', target, `L2 标记后命中 ${count} 个元素`, {
			level: 'L2',
			strategy,
			uid: winner.item.uid,
		})
	}

	if (opts.requireVisible && !winner.item.visible) {
		await strip()
		throw new ElementNotFoundError('HIDDEN', target, 'L2 命中元素但不可见', {
			level: 'L2',
			strategy,
			uid: winner.item.uid,
		})
	}

	log(
		`L2 ${strategy} 命中：uid=${winner.item.uid} score=${winner.score} ` +
			`（候选池 ${pool.length}）`,
	)

	return {
		locator,
		score: winner.score,
		strategy,
		matched: pool.length,
		release: strip,
	}
}
