/**
 * 参数化建议的规则引擎（docs/parameterization.md §2/§3；输出契约见 ./types.ts）。
 *
 * 设计原则：确定性规则只圈候选（recall），AI 裁决留到 Phase 2；
 * 每条建议的 reasons 必须是中文可读文本，UI 直接展示。
 *
 * 流程：flatten → 候选/排除 → 逐信号打分 → 置信度 → 按步骤顺序命名查重 → 排序 → 截断。
 */
import type { ElementRef, Flow, Step } from '@rr/schema'

import {
	attr,
	classifyValue,
	containsTemplate,
	fieldOf,
	fieldTexts,
	firstBusinessWord,
	flattenSteps,
	inputTypeOf,
	isGenericTextTarget,
	isSecretTarget,
	isShortNumber,
	mergedAttrs,
	resolveLabel,
	textHasAny,
	QUANTITY_WORDS_EN,
	QUANTITY_WORDS_ZH,
	SEARCH_WORDS_EN,
	SEARCH_WORDS_ZH,
	VALUE_FORMAT_LABEL,
	type FlatStep,
} from './internal.js'
import { deriveVariableName, deriveVariableType, makeUniqueName, type NameInput } from './naming.js'
import type {
	AnalyzeOptions,
	FlowSuggestions,
	ParamSuggestion,
	SuggestionConfidence,
	SuggestionTargetInfo,
} from './types.js'

/** §3：input type 命中即 +3 */
const TYPE_SIGNALS = new Set(['email', 'tel', 'date', 'number', 'url'])

/** 非数据步骤的排除原因（中文，UI 直接展示） */
const NON_DATA_REASON: Record<string, string> = {
	navigate: '导航步骤，没有可参数化的输入值',
	click: '点击步骤，不是数据输入',
	key: '按键步骤，不是数据输入',
	hover: '悬停步骤，不是数据输入',
	scroll: '滚动步骤，不是数据输入',
	drag: '拖拽步骤，不是数据输入',
	wait: '等待步骤，不是数据输入',
	assert: '断言步骤，不是数据输入',
	extract: '提取步骤，不是数据输入',
	script: '脚本步骤，不是数据输入',
	upload: '上传步骤的文件名由录制器自动参数化',
	dialog: '对话框步骤，不是数据输入',
	switchTab: '标签页切换步骤，不是数据输入',
}

const CONFIDENCE_RANK: Record<SuggestionConfidence, number> = { high: 0, medium: 1, weak: 2 }

interface Candidate {
	flat: FlatStep
	kind: 'input' | 'select'
	value: string
	target: ElementRef
}

interface Scored {
	candidate: Candidate
	score: number
	reasons: string[]
	confidence: SuggestionConfidence
	group?: { value: string; stepIds: string[] }
}

function confidenceOf(score: number): SuggestionConfidence {
	if (score >= 5) return 'high'
	if (score >= 3) return 'medium'
	return 'weak'
}

/** §2 候选与排除：只收 input / select(string)、非密码、非空、未模板化 */
function collectCandidates(flow: Flow, skipped: FlowSuggestions['skipped']): Candidate[] {
	const candidates: Candidate[] = []

	for (const flat of flattenSteps(flow.steps)) {
		const { step, index } = flat
		if (step.kind === 'group') continue // 容器步骤不进 skipped，组内步骤会单独分析

		if (step.kind === 'input' || step.kind === 'select') {
			const field = fieldOf(step)
			if (!field) continue

			if (Array.isArray(field.value)) {
				skipped.push({
					stepId: step.id,
					stepIndex: index,
					reason: '多选下拉（数组值），暂不支持参数化',
				})
				continue
			}
			if (isSecretTarget(field.target)) {
				skipped.push({
					stepId: step.id,
					stepIndex: index,
					reason: '密码/密钥字段，值已脱敏，不能参数化',
				})
				continue
			}
			if (containsTemplate(field.value)) {
				skipped.push({ stepId: step.id, stepIndex: index, reason: '值已经是 {{变量}} 模板' })
				continue
			}
			if (!field.value.trim()) {
				skipped.push({ stepId: step.id, stepIndex: index, reason: '值为空，没有可参数化的内容' })
				continue
			}

			candidates.push({ flat, kind: field.kind, value: field.value, target: field.target })
			continue
		}

		skipped.push({
			stepId: step.id,
			stepIndex: index,
			reason: NON_DATA_REASON[step.kind] ?? '非数据输入步骤',
		})
	}

	return candidates
}

/** §3 负向 1：搜索/筛选框（label/placeholder 词表，或 aria-autocomplete、combobox+listbox） */
function hasSearchSignal(target: ElementRef): boolean {
	const searchable = [resolveLabel(target), attr(target, 'placeholder')]
		.filter((value): value is string => typeof value === 'string' && value.length > 0)
		.join(' ')
	if (textHasAny(searchable, SEARCH_WORDS_ZH, SEARCH_WORDS_EN)) return true

	const attrs = mergedAttrs(target)
	const autocomplete = (attrs['aria-autocomplete'] ?? '').trim().toLowerCase()
	if (autocomplete && autocomplete !== 'none') return true

	const role = (attrs['role'] ?? target.fingerprint.role ?? '').trim().toLowerCase()
	const haspopup = (attrs['aria-haspopup'] ?? '').trim().toLowerCase()
	if (role === 'combobox' && haspopup.includes('listbox')) return true

	return false
}

function scoreCandidate(candidate: Candidate, valueCounts: Map<string, string[]>): Scored {
	const { target, value } = candidate
	const reasons: string[] = []
	let score = 0

	// 信号 1：input type ∈ email/tel/date/number/url → +3
	const inputType = inputTypeOf(target)
	if (inputType && TYPE_SIGNALS.has(inputType)) {
		score += 3
		reasons.push(`输入类型为 ${inputType}（+3）`)
	}

	// 信号 2：值格式（email / 手机号 / 日期 / 金额 / 长编号）→ +2
	const format = classifyValue(value)
	if (format) {
		score += 2
		reasons.push(`值符合${VALUE_FORMAT_LABEL[format]}格式（+2）`)
	}

	// 信号 3：字段词表 → +3
	const texts = fieldTexts(target)
	const businessWord = firstBusinessWord(texts)
	if (businessWord) {
		score += 3
		reasons.push(`字段名命中业务词「${businessWord}」（+3）`)
	}

	// 信号 4：同一值出现在 ≥2 个候选步骤 → +2（并生成 group）
	const sameValueSteps = valueCounts.get(value) ?? [candidate.flat.step.id]
	if (sameValueSteps.length >= 2) {
		score += 2
		reasons.push(`同一值在 ${sameValueSteps.length} 个步骤中重复出现（+2）`)
	}

	// 信号 5：1–3 位纯数字 + 数量词 → +1
	if (isShortNumber(value) && textHasAny(texts.join(' '), QUANTITY_WORDS_ZH, QUANTITY_WORDS_EN)) {
		score += 1
		reasons.push('短数字 + 数量词，疑似数量字段（+1）')
	}

	// 负向 1：搜索/筛选框 → -4
	if (hasSearchSignal(target)) {
		score -= 4
		reasons.push('疑似搜索/筛选框，通常是固定操作（-4）')
	}

	// 负向 2：textarea + 泛化文本 → -2
	if (isGenericTextTarget(target)) {
		score -= 2
		reasons.push('泛化文本域（备注/说明类），参数化收益低（-2）')
	}

	if (reasons.length === 0) reasons.push('未命中明确参数化信号（置信度低）')

	const group = sameValueSteps.length >= 2 ? { value, stepIds: [...sameValueSteps] } : undefined

	return { candidate, score, reasons, confidence: confidenceOf(score), group }
}

function buildTargetInfo(target: ElementRef, step: Step, stepIndex: number): SuggestionTargetInfo {
	const info: SuggestionTargetInfo = { tag: target.observed.tag, stepIndex }

	const label = resolveLabel(target)
	if (label) info.label = label
	const placeholder = attr(target, 'placeholder')
	if (placeholder) info.placeholder = placeholder
	const nameAttr = attr(target, 'name')
	if (nameAttr) info.nameAttr = nameAttr
	const inputType = attr(target, 'type')
	if (inputType) info.inputType = inputType
	// group 变体在 Step 联合类型里没有 page 字段；这里只在 input/select 上取值
	const pageIndex = step.kind === 'group' ? undefined : step.page?.index
	if (typeof pageIndex === 'number') info.pageIndex = pageIndex

	return info
}

/** 名称/类型推断的输入（§4：label > placeholder > nameAttr） */
function nameInputOf(candidate: Candidate): NameInput {
	const { target, flat } = candidate
	return {
		...(resolveLabel(target) ? { label: resolveLabel(target) } : {}),
		...(attr(target, 'placeholder') ? { placeholder: attr(target, 'placeholder') } : {}),
		...(attr(target, 'name') ? { nameAttr: attr(target, 'name') } : {}),
		stepIndex: flat.index,
		inputType: inputTypeOf(target),
	}
}

export function analyzeFlow(flow: Flow, opts: AnalyzeOptions = {}): FlowSuggestions {
	const skipped: FlowSuggestions['skipped'] = []
	const candidates = collectCandidates(flow, skipped)

	// 同值分组：只统计「候选步骤」（§3 信号 4）
	const valueCounts = new Map<string, string[]>()
	for (const candidate of candidates) {
		const stepIds = valueCounts.get(candidate.value) ?? []
		stepIds.push(candidate.flat.step.id)
		valueCounts.set(candidate.value, stepIds)
	}

	const scored = candidates.map((candidate) => scoreCandidate(candidate, valueCounts))
	const visible = scored.filter((item) => opts.includeWeak === true || item.confidence !== 'weak')

	// 命名查重按步骤顺序（candidates 已经是 flatten 顺序），与 flow.variables + 本批名字一起查
	const taken = new Set(flow.variables.map((variable) => variable.name))
	const suggestions: ParamSuggestion[] = []
	for (const item of visible) {
		const { candidate } = item
		const nameInput = nameInputOf(candidate)
		const baseName = deriveVariableName(nameInput)
		const suggestedName = makeUniqueName(baseName, taken)
		taken.add(suggestedName)

		suggestions.push({
			stepId: candidate.flat.step.id,
			kind: candidate.kind,
			currentValue: candidate.value,
			target: buildTargetInfo(candidate.target, candidate.flat.step, candidate.flat.index),
			suggestedName,
			suggestedType: deriveVariableType(nameInput),
			confidence: item.confidence,
			reasons: item.reasons,
			...(item.group ? { group: item.group } : {}),
		})
	}

	// §3 排序：confidence 高优先，再按 stepIndex 升序
	suggestions.sort(
		(a, b) =>
			CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
			a.target.stepIndex - b.target.stepIndex,
	)

	const limited =
		typeof opts.maxSuggestions === 'number'
			? suggestions.slice(0, Math.max(0, Math.floor(opts.maxSuggestions)))
			: suggestions

	return {
		generatedAt: new Date().toISOString(),
		flowVersion: flow.version,
		suggestions: limited,
		skipped,
	}
}
