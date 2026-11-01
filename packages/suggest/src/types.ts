/**
 * 参数化建议的公共契约（Lead 冻结，实现方只读）。
 *
 * 设计原则（来自产品讨论）：
 * - 确定性规则只负责「圈候选」（recall），置信度和理由必须可解释；
 * - 建议是**即时计算**的 DTO，不持久化；只有用户「接受」才写 IR；
 * - AI 裁决（Phase 2）通过 SuggestionAdjudicator 接口接入，Phase 1 不调用。
 */
import type { Flow } from '@rr/schema'

export type SuggestionConfidence = 'high' | 'medium' | 'weak'
export type SuggestFieldKind = 'input' | 'select' | 'upload'
export type SuggestVariableType = 'string' | 'text' | 'email' | 'date' | 'number'

/** 建议目标元素的可读信息（UI 展示 + Phase 2 AI 输入） */
export interface SuggestionTargetInfo {
	tag: string
	/** labels[0] / aria-label / placeholder / name / id 里优先级最高的那个 */
	label?: string
	placeholder?: string
	nameAttr?: string
	inputType?: string
	/** 所属标签页（多标签页流程用，0/undefined 表示起点页） */
	pageIndex?: number
	/** flatten 后的步骤下标（UI 显示"第 N 步"） */
	stepIndex: number
}

export interface ParamSuggestion {
	stepId: string
	kind: SuggestFieldKind
	/** 当前步骤里写死的值（password/secret 永远不会出现在建议里） */
	currentValue: string
	target: SuggestionTargetInfo
	suggestedName: string
	suggestedType: SuggestVariableType
	confidence: SuggestionConfidence
	/** 中文理由，UI 直接展示 */
	reasons: string[]
	/** 同值批量候选（含自己） */
	group?: { value: string; stepIds: string[] }
}

export interface FlowSuggestions {
	generatedAt: string
	flowVersion: number
	/** 默认只含 high/medium，按 confidence 再按 stepIndex 排序 */
	suggestions: ParamSuggestion[]
	/** 明确被排除的步骤及原因（多选/空值/搜索框…），UI 可折叠展示 */
	skipped: Array<{ stepId: string; stepIndex: number; reason: string }>
}

export interface AnalyzeOptions {
	/** 是否返回 weak（默认 false，调试/调参用） */
	includeWeak?: boolean
	/** 最多返回多少条建议（默认不限制） */
	maxSuggestions?: number
}

export interface ApplySuggestionInput {
	stepId: string
	name: string
	type?: SuggestVariableType
	/** true = 把 group 内所有同值步骤一起替换 */
	applySameValue?: boolean
}

export interface ApplyResult {
	flow: Flow
	/** 实际被替换的步骤 id（applySameValue 时可能多于 1 个） */
	changedStepIds: string[]
}

/**
 * Phase 2：AI 裁决接口（Phase 1 不实现、不调用）。
 * 契约里约定只传字段语义 + **脱敏后的值格式**，绝不传原文/DOM/截图。
 */
export interface SuggestionAdjudicator {
	judge(input: {
		target: SuggestionTargetInfo
		currentValueFormat: 'email' | 'phone' | 'date' | 'number' | 'id-like' | 'text'
		currentValueMasked: string
		ruleReasons: string[]
		ruleConfidence: SuggestionConfidence
	}): Promise<{
		isVariable: boolean
		name?: string
		type?: SuggestVariableType
		reason: string
		confidence: number
	} | null>
}
