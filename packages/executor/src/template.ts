/**
 * 变量替换（纯函数，可单测）。
 *
 * 契约：变量用 `{{var}}` 模板；缺失变量直接失败并给出明确原因（不能填空串）。
 * 变量集 = flow.variables 的 defaultValue（若有）+ opts.variables（后者覆盖）。
 */
import { resolveTemplate, type Step } from '@rr/schema'

import { TemplateError } from './errors.js'

/** 渲染单个模板串；把 schema 的中文报错转成带变量名的 TemplateError */
export function renderTemplateValue(value: string, vars: Record<string, string>): string {
	try {
		return resolveTemplate(value, vars)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const match = /"([^"]+)"/.exec(message)
		const variable = match?.[1]
		throw new TemplateError(
			variable ? `缺少变量 "${variable}"` : `模板渲染失败：${message}`,
			variable,
		)
	}
}

/** 从 flow.variables 构造默认变量表（只取有 defaultValue 的；secret 由调用方注入） */
export function defaultVariables(
	variables: ReadonlyArray<{ name: string; defaultValue?: string | undefined }>,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const variable of variables) {
		if (variable.defaultValue !== undefined) out[variable.name] = variable.defaultValue
	}
	return out
}

function renderMaybe(value: string | undefined, vars: Record<string, string>): string | undefined {
	if (value === undefined) return undefined
	return renderTemplateValue(value, vars)
}

/**
 * 深拷贝 step 并渲染其中的模板字段。
 * 只渲染**动作参数**（url/value/files/key/expect.pattern/assert.text），不动 ElementRef。
 */
export function renderStep(step: Step, vars: Record<string, string>): Step {
	const clone = structuredClone(step)

	switch (clone.kind) {
		case 'navigate':
			clone.url = renderTemplateValue(clone.url, vars)
			break
		case 'input':
			clone.value = renderTemplateValue(clone.value, vars)
			break
		case 'select': {
			if (Array.isArray(clone.value)) {
				clone.value = clone.value.map((v) => renderTemplateValue(v, vars))
			} else {
				clone.value = renderTemplateValue(clone.value, vars)
			}
			break
		}
		case 'key':
			clone.key = renderTemplateValue(clone.key, vars)
			break
		case 'upload':
			clone.files = clone.files.map((f) => renderTemplateValue(f, vars))
			break
		case 'group':
			clone.steps = clone.steps.map((s) => renderStep(s, vars))
			break
		default:
			break
	}

	if (clone.expect) {
		if (clone.expect.kind === 'urlChange') {
			clone.expect = { kind: 'urlChange', pattern: renderTemplateValue(clone.expect.pattern, vars) }
		} else if (clone.expect.kind === 'textChange') {
			clone.expect = { ...clone.expect, to: renderTemplateValue(clone.expect.to, vars) }
		}
	}

	if (clone.kind === 'assert') {
		const assertion = clone.assertion
		if (assertion.kind === 'text') {
			clone.assertion = {
				...assertion,
				...(renderMaybe(assertion.equals, vars) !== undefined
					? { equals: renderTemplateValue(assertion.equals as string, vars) }
					: {}),
				...(assertion.contains !== undefined
					? { contains: renderTemplateValue(assertion.contains, vars) }
					: {}),
			}
		} else if (assertion.kind === 'value') {
			clone.assertion = { kind: 'value', equals: renderTemplateValue(assertion.equals, vars) }
		}
	}

	return clone
}
