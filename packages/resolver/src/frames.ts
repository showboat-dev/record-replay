/**
 * FramePath → 进入 iframe 的解析。
 *
 * schema 里三种 segment：
 * - `frameElement`：用 anchor 的候选把 iframe 元素解析出来，再 `contentFrame()` 进入（最可靠）；
 * - `urlPattern`：按子 frame 的 URL 通配匹配（`*` 通配）；
 * - `index`：按子 frame 顺序（最后手段）。
 *
 * 注意：跨域 iframe 一样能进去（Playwright 的 Frame API 不受同源限制），
 * 但如果 anchor 解析失败就只能靠 urlPattern/index 兜底。
 */
import type { ElementRef, FramePath, FrameSegment } from '@rr/schema'
import type { Frame, Page } from 'playwright'

import { resolveL1, type L1Options } from './l1.js'
import type { Scope } from './types.js'
import { matchesUrlPattern, rebaseUrl } from './url.js'

export function isPage(scope: Scope): scope is Page {
	return typeof (scope as Page).mainFrame === 'function' && !('parentFrame' in scope)
}

/** 当前作用域下的直接子 frame */
export function childFramesOf(scope: Scope): Frame[] {
	if (isPage(scope)) return scope.mainFrame().childFrames()
	return scope.childFrames()
}

/** `**\/basic*` 这类通配 → 正则 */
export function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
	const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
	return new RegExp(body)
}

export interface FrameEnterResult {
	scope: Scope
	depth: number
	detail: string[]
}

export interface FrameEnterOptions extends L1Options {
	/** urlPattern/index 段的重试次数（frame 可能还没加载好），默认 3 次 × 300ms */
	frameWaitRetries?: number
	frameWaitMs?: number
	/** 回放环境 origin 覆盖（录制在 5199、回放在 5173 时 urlPattern 必须重定基） */
	baseUrl?: string
}

async function findBySegment(
	scope: Scope,
	segment: FrameSegment,
	opts: FrameEnterOptions,
	log: (msg: string) => void,
): Promise<Frame | undefined> {
	if (segment.kind === 'frameElement') {
		const anchorRef: ElementRef = {
			observed: segment.anchor.observed,
			candidates: segment.anchor.candidates,
			fingerprint: segment.anchor.fingerprint,
			frame: { path: [] },
		}
		const hit = await resolveL1(anchorRef, scope, opts, log)
		const handle = await hit.locator.elementHandle()
		if (!handle) return undefined
		const frame = await handle.contentFrame()
		return frame ?? undefined
	}

	const retries = opts.frameWaitRetries ?? 3
	const waitMs = opts.frameWaitMs ?? 300
	for (let attempt = 0; attempt <= retries; attempt++) {
		const frames = childFramesOf(scope)
		if (segment.kind === 'urlPattern') {
			const matched = frames.find((f) =>
				matchesUrlPattern(f.url(), segment.pattern, opts.baseUrl, wildcardToRegExp),
			)
			if (matched) return matched
		} else {
			const byIndex = frames[segment.index]
			if (byIndex) return byIndex
		}
		if (attempt < retries) await new Promise((r) => setTimeout(r, waitMs))
	}
	return undefined
}

/** 按 FramePath 逐层进入，返回最内层作用域 */
export async function enterFrameScope(
	page: Page,
	framePath: FramePath | undefined,
	opts: FrameEnterOptions,
	log: (msg: string) => void,
): Promise<FrameEnterResult> {
	const segments = framePath?.path ?? []
	let scope: Scope = page
	const detail: string[] = []
	let depth = 0

	for (const segment of segments) {
		// recorder 产出的 frame.path 可能是 [frameElement(host iframe), urlPattern(该 iframe 的 URL)]：
		// 此时 urlPattern 描述的是**同一层**（用作校验/兜底），不是下一层嵌套。
		// 判定规则：当前作用域已经是 Frame 且 URL 命中 pattern → 视为校验，不再下钻。
		if (segment.kind === 'urlPattern' && !isPage(scope)) {
			if (matchesUrlPattern(scope.url(), segment.pattern, opts.baseUrl, wildcardToRegExp)) {
				detail.push(`frame[${depth - 1}] urlPattern 校验 ✓ ${scope.url()}`)
				log(`frame 第 ${depth} 层 urlPattern 校验通过：${scope.url()}`)
				continue
			}
		}

		const frame = await findBySegment(scope, segment, opts, log)
		if (!frame) {
			const desc =
				segment.kind === 'frameElement'
					? 'frameElement'
					: segment.kind === 'urlPattern'
						? `urlPattern(${rebaseUrl(segment.pattern, opts.baseUrl)})`
						: `index(${segment.index})`
			throw new Error(
				`无法进入 frame 第 ${depth + 1} 层（${desc}）：未找到匹配的子 frame。` +
					`当前层子 frame: [${childFramesOf(scope)
						.map((f) => f.url())
						.join(', ')}]`,
			)
		}
		scope = frame
		depth += 1
		detail.push(`frame[${depth - 1}] ${frame.url()}`)
		log(`进入 frame ${depth}: ${frame.url()}`)
	}

	return { scope, depth, detail }
}
