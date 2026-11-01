/**
 * 占位实现：M1 由 resolver 负责人替换。接口契约见 docs/architecture.md §4。
 */
import type { ElementRef } from '@rr/schema'
import type { Locator, Page } from 'playwright'

export type ResolveLevel = 'L1' | 'L2' | 'L3' | 'L4'

export interface ResolveContext {
	page: Page
	repair?: (target: ElementRef, reason: string) => Promise<Locator | null>
	log?: (msg: string) => void
}

export interface ResolveResult {
	locator: Locator
	level: ResolveLevel
	score: number
	ambiguous: boolean
}

export async function resolve(_target: ElementRef, _ctx: ResolveContext): Promise<ResolveResult> {
	throw new Error('@rr/resolver 尚未实现（M1）')
}
