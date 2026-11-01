/**
 * 占位实现：M1 由 recorder 负责人替换。接口契约见 docs/architecture.md §3。
 */
import type { Flow, Step } from '@rr/schema'

export interface RecordOptions {
	startUrl: string
	outPath: string
	viewport?: { width: number; height: number }
	headless?: boolean
	artifactsRoot?: string
	keepRaw?: boolean
	onStep?: (step: Step) => void
	stopSignal?: AbortSignal
}

export interface RecordResult {
	flow: Flow
	artifactsDir: string
	rawPath?: string
}

export async function record(_opts: RecordOptions): Promise<RecordResult> {
	throw new Error('@rr/recorder 尚未实现（M1）')
}
