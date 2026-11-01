/**
 * 应用/重命名（docs/parameterization.md §5）。
 *
 * 纯函数：深拷贝返回新 flow，不落盘、不动 version（由 Studio 的 updateFlow 负责）。
 * 非法输入统一抛 SuggestError（Studio 转 400 + 中文原因）。
 */
import type { Flow, Step, Variable } from '@rr/schema'

import { SuggestError } from './errors.js'
import {
	cloneFlow,
	containsTemplate,
	fieldOf,
	findFlatStep,
	flattenSteps,
	isSecretTarget,
	isValidVariableName,
	replaceTemplateName,
} from './internal.js'
import type { ApplyResult, ApplySuggestionInput, SuggestVariableType } from './types.js'

const NAME_RULE = '变量名只能用字母/数字/下划线，且不能以数字开头'

/** 只支持 input / select(string)；数组 select 由调用方先拦截 */
function setFieldValue(step: Step, value: string): boolean {
	if (step.kind === 'input') {
		step.value = value
		return true
	}
	if (step.kind === 'select') {
		step.value = value
		return true
	}
	return false
}

/**
 * 复用已存在的同名变量，或补一条 `{name,type,secret:false,source:'input'}` 定义。
 * 类型兼容规则：同类型复用；已有 string 而本次给了更具体类型 → 升级；已有具体类型而本次
 * 只给 string → 保留具体类型；两个具体类型不同或变量是 secret/file → NAME_CONFLICT。
 */
function ensureVariable(flow: Flow, name: string, requestedType?: SuggestVariableType): void {
	const existing = flow.variables.find((variable) => variable.name === name)
	if (!existing) {
		const variable: Variable = {
			name,
			type: requestedType ?? 'string',
			secret: false,
			source: 'input',
		}
		flow.variables.push(variable)
		return
	}

	if (existing.secret || existing.type === 'secret' || existing.type === 'file') {
		throw new SuggestError(
			'NAME_CONFLICT',
			`变量 "${name}" 已存在且不是普通输入变量（type=${existing.type}），请换一个名字`,
		)
	}
	if (!requestedType || existing.type === requestedType) return
	if (existing.type === 'string') {
		// 之前以 string 默认创建，本次有更具体的类型 → 升级
		existing.type = requestedType
		return
	}
	if (requestedType === 'string') return // 保留已有的更具体类型
	throw new SuggestError(
		'NAME_CONFLICT',
		`变量 "${name}" 已存在且类型为 ${existing.type}，与本次类型 ${requestedType} 冲突`,
	)
}

export function applySuggestion(flow: Flow, input: ApplySuggestionInput): ApplyResult {
	const name = input.name.trim()
	if (!isValidVariableName(name)) {
		throw new SuggestError('INVALID_NAME', `变量名 "${input.name}" 不合法：${NAME_RULE}`)
	}

	const next = cloneFlow(flow)
	const flat = findFlatStep(next, input.stepId)
	if (!flat) throw new SuggestError('STEP_NOT_FOUND', `找不到步骤 "${input.stepId}"`)

	const step = flat.step
	const field = fieldOf(step)
	if (!field) {
		throw new SuggestError(
			'UNSUPPORTED_STEP',
			`步骤 "${step.id}"（${step.kind}）不是可参数化的输入/下拉步骤`,
		)
	}
	if (Array.isArray(field.value)) {
		throw new SuggestError('UNSUPPORTED_STEP', `步骤 "${step.id}" 是多选下拉，暂不支持参数化`)
	}
	if (isSecretTarget(field.target)) {
		throw new SuggestError(
			'UNSUPPORTED_STEP',
			`步骤 "${step.id}" 是密码/密钥字段，不支持直接参数化（请使用 secret 变量）`,
		)
	}
	if (containsTemplate(field.value)) {
		throw new SuggestError(
			'VALUE_ALREADY_TEMPLATED',
			`步骤 "${step.id}" 的值已经是模板，无需重复参数化`,
		)
	}
	if (!field.value.trim()) {
		throw new SuggestError('EMPTY_VALUE', `步骤 "${step.id}" 的值为空，无法参数化`)
	}

	ensureVariable(next, name, input.type)

	// applySameValue：把「同值且同样可参数化」的步骤一起替换（密码/数组/已模板化跳过）
	const targetValue = field.value
	const targetIds = new Set<string>([step.id])
	if (input.applySameValue === true) {
		for (const item of flattenSteps(next.steps)) {
			if (item.step.id === step.id) continue
			const other = fieldOf(item.step)
			if (!other || Array.isArray(other.value)) continue
			if (other.value !== targetValue) continue
			if (isSecretTarget(other.target)) continue
			if (containsTemplate(other.value)) continue
			targetIds.add(item.step.id)
		}
	}

	const changedStepIds: string[] = []
	for (const item of flattenSteps(next.steps)) {
		if (!targetIds.has(item.step.id)) continue
		if (setFieldValue(item.step, `{{${name}}}`)) changedStepIds.push(item.step.id)
	}

	return { flow: next, changedStepIds }
}

export function applySuggestions(flow: Flow, inputs: ApplySuggestionInput[]): ApplyResult {
	let current = cloneFlow(flow)
	const changed: string[] = []
	for (const input of inputs) {
		const result = applySuggestion(current, input)
		current = result.flow
		for (const stepId of result.changedStepIds) {
			if (!changed.includes(stepId)) changed.push(stepId)
		}
	}
	return { flow: current, changedStepIds: changed }
}

/** 只替换模板字段里的 {{old}}；保留其他模板 */
function replaceStepTemplates(step: Step, from: string, to: string): void {
	switch (step.kind) {
		case 'navigate':
			step.url = replaceTemplateName(step.url, from, to)
			break
		case 'input':
			step.value = replaceTemplateName(step.value, from, to)
			break
		case 'select':
			step.value =
				typeof step.value === 'string'
					? replaceTemplateName(step.value, from, to)
					: step.value.map((item) => replaceTemplateName(item, from, to))
			break
		case 'upload':
			step.files = step.files.map((file) => replaceTemplateName(file, from, to))
			break
		case 'dialog':
			if (typeof step.promptText === 'string') {
				step.promptText = replaceTemplateName(step.promptText, from, to)
			}
			break
		default:
			break
	}
}

/** 重命名已存在的变量：改定义 + 所有 {{old}} 模板（input/select/upload/dialog.promptText/navigate.url） */
export function renameVariable(flow: Flow, from: string, to: string): Flow {
	const fromName = from.trim()
	const toName = to.trim()

	if (!isValidVariableName(toName)) {
		throw new SuggestError('INVALID_NAME', `变量名 "${to}" 不合法：${NAME_RULE}`)
	}
	if (fromName === toName) return cloneFlow(flow)

	const next = cloneFlow(flow)
	const variable = next.variables.find((item) => item.name === fromName)
	if (!variable) throw new SuggestError('STEP_NOT_FOUND', `变量 "${from}" 不存在`)
	if (next.variables.some((item) => item.name === toName)) {
		throw new SuggestError('NAME_CONFLICT', `变量 "${to}" 已存在`)
	}

	variable.name = toName
	for (const { step } of flattenSteps(next.steps)) {
		replaceStepTemplates(step, fromName, toName)
	}
	return next
}
