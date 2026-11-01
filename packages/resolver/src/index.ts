/**
 * Resolver 公共入口（契约见 docs/architecture.md §4）。
 *
 * 解析阶梯：L1 语义候选 → L2 stableHash 指纹 → L4 AI 兜底（由 executor 注入）。
 * L3（nodePath 容错）按计划 M1 不实现，遇到会跳过并记日志。
 */
import type { ElementRef } from '@rr/schema'
import type { Locator } from 'playwright'

import { ElementNotFoundError } from './errors.js'
import { resolveL2 } from './fingerprint.js'
import { enterFrameScope } from './frames.js'
import { resolveL1 } from './l1.js'
import {
	sortCandidates,
	type ResolveContext,
	type ResolveLevel,
	type ResolveOptions,
	type ResolveResult,
	type Scope,
} from './types.js'

export * from './errors.js'
export * from './hash.js'
export * from './score.js'
export * from './types.js'
export * from './url.js'
export { candidateLocator, describeCandidate } from './candidates.js'
export { enterFrameScope, wildcardToRegExp } from './frames.js'
export { resolveL1 } from './l1.js'
export { L2_MARKER, resolveL2 } from './fingerprint.js'

const DEFAULT_LEVELS: ResolveLevel[] = ['L1', 'L2', 'L4']

interface NormalizedOptions {
	requireVisible: boolean
	allowAi: boolean
	ambiguityThreshold: number
	maxFingerprintMatches: number
	baseUrl?: string
	levels: ResolveLevel[]
}

function withDefaults(options?: ResolveOptions): NormalizedOptions {
	return {
		requireVisible: options?.requireVisible ?? true,
		allowAi: options?.allowAi ?? true,
		ambiguityThreshold: options?.ambiguityThreshold ?? 0.15,
		maxFingerprintMatches: options?.maxFingerprintMatches ?? 80,
		baseUrl: options?.baseUrl,
		levels: options?.levels ?? DEFAULT_LEVELS,
	}
}

/** 快速自检：ref 结构是否可尝试（避免把明显非法的 IR 送进页面） */
function assertRefSane(target: ElementRef): void {
	if (!target || typeof target !== 'object') {
		throw new Error('ElementRef 为空')
	}
	if (!Array.isArray(target.candidates) || target.candidates.length === 0) {
		throw new ElementNotFoundError('INVALID_REF', target, 'ElementRef.candidates 为空')
	}
	if (!target.observed?.rect) {
		throw new ElementNotFoundError('INVALID_REF', target, 'ElementRef.observed.rect 缺失')
	}
	for (const candidate of target.candidates) {
		if (typeof candidate.value === 'string') continue
		if (candidate.kind !== 'role') {
			throw new ElementNotFoundError(
				'INVALID_REF',
				target,
				`非 role 候选必须是字符串（kind=${candidate.kind}）`,
			)
		}
		if (!candidate.value?.role) {
			throw new ElementNotFoundError('INVALID_REF', target, 'role 候选缺少 role 字段')
		}
	}
}

/** L4：把 AI 给的结果校验成可用 Locator（必须是唯一且可见） */
async function validateAiLocator(
	locator: Locator,
	target: ElementRef,
	timeoutMs: number,
): Promise<void> {
	const count = await locator.count()
	if (count === 0) {
		throw new ElementNotFoundError('AI_FAILED', target, 'AI 给出的定位在页面上找不到元素')
	}
	if (count > 1) {
		throw new ElementNotFoundError(
			'AI_FAILED',
			target,
			`AI 给出的定位命中 ${count} 个元素（要求唯一）`,
		)
	}
	try {
		await locator.waitFor({ state: 'visible', timeout: timeoutMs })
	} catch {
		throw new ElementNotFoundError('AI_FAILED', target, 'AI 给出的定位命中元素但不可见')
	}
}

export async function resolve(target: ElementRef, ctx: ResolveContext): Promise<ResolveResult> {
	const opts = withDefaults(ctx.options)
	const log = ctx.log ?? (() => {})
	assertRefSane(target)

	// ---- frame 链：先把作用域切到最内层 iframe ----
	let scope: Scope = ctx.page
	let frameDepth = 0
	if (target.frame?.path && target.frame.path.length > 0) {
		try {
			const entered = await enterFrameScope(
				ctx.page,
				target.frame,
				{
					requireVisible: opts.requireVisible,
					ambiguityThreshold: opts.ambiguityThreshold,
					// frame 元素本身要求可见，否则 Playwright 也点不进去
					frameWaitRetries: 3,
					...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
				},
				log,
			)
			scope = entered.scope
			frameDepth = entered.depth
		} catch (err) {
			throw new ElementNotFoundError('INVALID_FRAME', target, (err as Error).message, {
				frame: target.frame,
			})
		}
	}

	const failures: string[] = []
	let sawAmbiguous = false
	let sawHidden = false

	for (const level of opts.levels) {
		if (level === 'L3') {
			log('L3（nodePath 容错）按计划 M1 未实现，跳过')
			continue
		}

		if (level === 'L1') {
			try {
				const hit = await resolveL1(
					target,
					scope,
					{
						requireVisible: opts.requireVisible,
						ambiguityThreshold: opts.ambiguityThreshold,
					},
					log,
				)
				return {
					locator: hit.locator,
					level: 'L1',
					score: hit.score,
					ambiguous: false,
					frameDepth,
					reason: `L1 ${hit.candidate.kind} 唯一命中`,
				}
			} catch (err) {
				if (!(err instanceof ElementNotFoundError)) throw err
				if (err.code === 'INVALID_REF') throw err
				if (err.code === 'AMBIGUOUS') sawAmbiguous = true
				if (err.code === 'HIDDEN') sawHidden = true
				failures.push(`L1 ${err.code}: ${err.message}`)
				log(`L1 失败（${err.code}）：${err.message}`)
			}
			continue
		}

		if (level === 'L2') {
			try {
				const hit = await resolveL2(
					target,
					scope,
					{
						requireVisible: opts.requireVisible,
						ambiguityThreshold: opts.ambiguityThreshold,
						maxFingerprintMatches: opts.maxFingerprintMatches,
					},
					log,
				)
				return {
					locator: hit.locator,
					level: 'L2',
					score: hit.score,
					// L1 歧义后靠指纹定下来：结果可用，但必须让上层知道"签名本身有歧义"
					ambiguous: sawAmbiguous,
					strategy: hit.strategy,
					frameDepth,
					reason:
						`L2 ${hit.strategy} 命中（候选池 ${hit.matched}）` +
						(sawAmbiguous ? '；L1 曾歧义，已降级' : ''),
					release: hit.release,
				}
			} catch (err) {
				if (!(err instanceof ElementNotFoundError)) throw err
				if (err.code === 'AMBIGUOUS') sawAmbiguous = true
				if (err.code === 'HIDDEN') sawHidden = true
				failures.push(`L2 ${err.code}: ${err.message}`)
				log(`L2 失败（${err.code}）：${err.message}`)
			}
			continue
		}

		if (level === 'L4') {
			if (!ctx.repair || !opts.allowAi) {
				log('L4 跳过：未注入 AI repair（默认关闭）')
				continue
			}
			const reason = failures.join(' | ')
			try {
				const locator = await ctx.repair(target, reason)
				if (!locator) {
					failures.push('L4 AI 未能给出定位')
					log('L4 失败：AI 返回空')
					continue
				}
				await validateAiLocator(locator, target, 5_000)
				return {
					locator,
					level: 'L4',
					score: 0,
					ambiguous: sawAmbiguous,
					strategy: 'ai',
					frameDepth,
					reason: 'L4 AI 兜底命中（建议写回并复核）',
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				failures.push(`L4 AI_FAILED: ${message}`)
				log(`L4 失败（AI_FAILED）：${message}`)
			}
			continue
		}
	}

	const code = sawAmbiguous ? 'AMBIGUOUS' : sawHidden ? 'HIDDEN' : 'NO_MATCH'
	const head =
		code === 'AMBIGUOUS'
			? '元素存在歧义，拒绝猜测（top1/top2 分差 < 15%）'
			: code === 'HIDDEN'
				? '元素命中但不可见/不可交互'
				: '元素在页面上找不到（L1 语义 + L2 指纹 + L4 AI 全部未命中）'
	throw new ElementNotFoundError(code, target, head, {
		levels: opts.levels,
		frameDepth,
		failures,
		candidates: sortCandidates(target.candidates).map((c) =>
			typeof c.value === 'string' ? `${c.kind}(${c.value})` : `role(${c.value.role})`,
		),
		url: ctx.page.url(),
	})
}
