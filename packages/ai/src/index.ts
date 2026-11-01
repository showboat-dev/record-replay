/**
 * 占位实现：M1 由 AI 负责人替换。接口契约见 docs/architecture.md §6。
 */
import type { Candidate, ElementRef } from '@rr/schema'

export interface AiConfig {
	baseUrl: string
	apiKey: string
	model: string
	timeoutMs?: number
	sendScreenshot?: boolean
}

export interface RepairInput {
	url: string
	target: ElementRef
	ariaSnapshot: string
	candidates: Candidate[]
	screenshotPng?: Buffer
}

export interface RepairOutput {
	ref?: string
	confidence: number
	reason: string
}

export interface RepairClient {
	locate(input: RepairInput): Promise<RepairOutput | null>
}

export function createRepairClient(_cfg?: Partial<AiConfig>): RepairClient | null {
	return null
}

export function redact(text: string): string {
	return text
}
