/**
 * 占位实现：M1 由 executor 负责人替换。接口契约见 docs/architecture.md §5。
 */
import type { Flow, Step } from '@rr/schema'

import type { RepairClient } from '@rr/ai'
import type { ResolveLevel } from '@rr/resolver'

export type ErrorCode =
	| 'ELEMENT_NOT_FOUND'
	| 'NOT_ACTIONABLE'
	| 'NO_EFFECT'
	| 'EXPECT_MISMATCH'
	| 'NAVIGATION_FAILED'
	| 'DIALOG_UNEXPECTED'
	| 'BROWSER_CRASH'

export interface StepResult {
	stepId: string
	kind: Step['kind']
	status: 'pass' | 'fail' | 'skip'
	level?: ResolveLevel
	ms: number
	error?: { code: ErrorCode; message: string }
}

export interface RunResult {
	flowId: string
	runId: string
	ok: boolean
	steps: StepResult[]
	metrics: { totalMs: number; passCount: number; failCount: number }
}

export interface PlayOptions {
	flow: Flow
	variables?: Record<string, string>
	headless?: boolean
	timeoutMs?: number
	artifactsRoot?: string
	ai?: RepairClient | null
	onStep?: (r: StepResult) => void
	runs?: number
}

export async function playFlow(_opts: PlayOptions): Promise<RunResult> {
	throw new Error('@rr/executor 尚未实现（M1）')
}

export async function playRuns(_opts: PlayOptions): Promise<RunResult[]> {
	throw new Error('@rr/executor 尚未实现（M1）')
}
