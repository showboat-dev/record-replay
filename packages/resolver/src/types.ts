/**
 * 公共类型。契约见 docs/architecture.md §4；`ResolveOptions` 是**追加**的可选项，
 * 不改变 `resolve(target, ctx)` 的两参签名，保证 CLI/harness 侧不用改。
 */
import type { Candidate, ElementRef } from '@rr/schema'
import type { Frame, Locator, Page } from 'playwright'

export type ResolveLevel = 'L1' | 'L2' | 'L3' | 'L4'

/** 解析作用域：主文档是 Page，进入 iframe 后是 Frame（两者 API 基本一致） */
export type Scope = Page | Frame

export interface ResolveOptions {
	/** 是否要求命中元素可见（默认 true；expect.elementHidden 场景可关掉） */
	requireVisible?: boolean
	/** 是否允许调用 ctx.repair（默认 true，由 executor 决定是否注入 repair） */
	allowAi?: boolean
	/** 允许的层级顺序，默认 ['L1','L2','L4']（L3=nodePath 容错按计划暂不实现） */
	levels?: ResolveLevel[]
	/** 歧义阈值，默认 0.15 */
	ambiguityThreshold?: number
	/** L2 页面内最多收集多少个指纹候选项，默认 80 */
	maxFingerprintMatches?: number
	/**
	 * 回放环境 origin 覆盖。用于 iframe `urlPattern` 段的重定基：
	 * 录制时 frame.url 带 5199，回放在 5173，不重定基就永远匹配不上。
	 */
	baseUrl?: string
}

export interface ResolveContext {
	page: Page
	/** AI 兜底（L4），由 executor 注入；null/undefined 表示禁用 */
	repair?: (target: ElementRef, reason: string) => Promise<Locator | null>
	log?: (msg: string) => void
	options?: ResolveOptions
}

export interface ResolveResult {
	locator: Locator
	level: ResolveLevel
	/** 0..100；L1 唯一语义命中 = 100，L2 按几何相似度，L4 固定 0 */
	score: number
	/** 本次解析曾遇到歧义（top1/top2 分差不足）而被迫降级 */
	ambiguous: boolean
	/** L2 的匹配策略：hash=stableHash 精确命中，attrs=按录制指纹字段全等命中 */
	strategy?: 'hash' | 'attrs' | 'ai'
	/** 进入的 frame 层数（0 = 主文档） */
	frameDepth?: number
	/** 一句话说明（写进 result.json，便于定位为什么没走 L1） */
	reason?: string
	/** L2 打了临时标记，action 结束后必须调用它清理（executor 保证 finally 调用） */
	release?: () => Promise<void>
}

/** candidates 按 score 升序（小的更可信）；同分保留原顺序（稳定排序） */
export function sortCandidates(candidates: Candidate[]): Candidate[] {
	return [...candidates].sort((a, b) => a.score - b.score)
}
