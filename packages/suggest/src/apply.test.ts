/**
 * apply.ts 单测：applySuggestion / applySuggestions / renameVariable。
 * 语义出处：docs/parameterization.md §5。
 */
import { parseFlow, type Flow, type Step } from '@rr/schema'
import { describe, expect, it } from 'vitest'

import { applySuggestion, applySuggestions, renameVariable } from './apply.js'
import { SuggestError } from './errors.js'
import { findFlatStep } from './internal.js'
import {
	dialogStep,
	groupStep,
	inputStep,
	makeFlow,
	makeRef,
	navigateStep,
	selectStep,
	uploadStep,
	variable,
} from './test-helpers.js'

function emailTarget(label = '邮箱') {
	return makeRef({ attrs: { type: 'email', name: 'email' }, label })
}

function stepOf(flow: Flow, stepId: string): Step {
	const flat = findFlatStep(flow, stepId)
	if (!flat) throw new Error(`测试 flow 里没有步骤 ${stepId}`)
	return flat.step
}

function inputValue(flow: Flow, stepId: string): string {
	const step = stepOf(flow, stepId)
	if (step.kind !== 'input') throw new Error(`${stepId} 不是 input`)
	return step.value
}

function errorCodeOf(fn: () => unknown): string {
	try {
		fn()
	} catch (error) {
		if (error instanceof SuggestError) return error.code
		throw error
	}
	throw new Error('预期抛出 SuggestError，但没有抛错')
}

describe('applySuggestion —— 单步替换', () => {
	it('替换 value 为 {{name}}、补变量定义、返回纯函数结果', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])

		const result = applySuggestion(flow, { stepId: 's1', name: 'email', type: 'email' })

		expect(result.changedStepIds).toEqual(['s1'])
		expect(inputValue(result.flow, 's1')).toBe('{{email}}')
		expect(result.flow.variables).toEqual([
			{ name: 'email', type: 'email', secret: false, source: 'input' },
		])
		// 纯函数：原 flow 不被修改
		expect(inputValue(flow, 's1')).toBe('a@b.com')
		expect(flow.variables).toHaveLength(0)
	})

	it('apply 之后 parseFlow 仍通过（IR 合法）', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])

		const result = applySuggestion(flow, { stepId: 's1', name: 'email', type: 'email' })
		const parsed = parseFlow(result.flow)

		expect(parsed.variables[0]).toMatchObject({ name: 'email', type: 'email', source: 'input' })
		expect(stepOf(parsed, 's1')).toMatchObject({ kind: 'input', value: '{{email}}' })
	})

	it('已存在同名且类型兼容的变量 → 复用，不重复定义', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())], [variable('email', 'email')])

		const result = applySuggestion(flow, { stepId: 's1', name: 'email', type: 'email' })

		expect(result.flow.variables).toHaveLength(1)
		expect(inputValue(result.flow, 's1')).toBe('{{email}}')
	})

	it('已存在 string 变量 + 本次给具体类型 → 升级类型', () => {
		const flow = makeFlow(
			[inputStep('s1', 'a@b.com', emailTarget())],
			[variable('email', 'string')],
		)

		const result = applySuggestion(flow, { stepId: 's1', name: 'email', type: 'email' })
		expect(result.flow.variables[0]?.type).toBe('email')
	})

	it('同名但类型冲突 → NAME_CONFLICT', () => {
		const flow = makeFlow(
			[inputStep('s1', '42', makeRef({ label: '数量' }))],
			[variable('qty', 'number')],
		)

		expect(
			errorCodeOf(() => applySuggestion(flow, { stepId: 's1', name: 'qty', type: 'email' })),
		).toBe('NAME_CONFLICT')
	})
})

describe('applySuggestion —— 非法输入', () => {
	it.each(['1abc', '中文', 'a-b', 'a b', ''])('非法变量名 %j → INVALID_NAME', (name) => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])
		expect(errorCodeOf(() => applySuggestion(flow, { stepId: 's1', name }))).toBe('INVALID_NAME')
	})

	it('步骤不存在 → STEP_NOT_FOUND', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])
		expect(errorCodeOf(() => applySuggestion(flow, { stepId: 'nope', name: 'x' }))).toBe(
			'STEP_NOT_FOUND',
		)
	})

	it('非 input/select 步骤 → UNSUPPORTED_STEP', () => {
		const flow = makeFlow([
			{
				kind: 'click',
				id: 'c1',
				target: makeRef({ tag: 'button' }),
				button: 'left',
				clickCount: 1,
				modifiers: [],
			},
		])
		expect(errorCodeOf(() => applySuggestion(flow, { stepId: 'c1', name: 'x' }))).toBe(
			'UNSUPPORTED_STEP',
		)
	})

	it('数组 select（多选）→ UNSUPPORTED_STEP', () => {
		const flow = makeFlow([selectStep('s1', ['a', 'b'], makeRef({ tag: 'select' }))])
		expect(errorCodeOf(() => applySuggestion(flow, { stepId: 's1', name: 'x' }))).toBe(
			'UNSUPPORTED_STEP',
		)
	})

	it('upload 步骤 → UNSUPPORTED_STEP', () => {
		const flow = makeFlow([uploadStep('u1', ['a.png'])])
		expect(errorCodeOf(() => applySuggestion(flow, { stepId: 'u1', name: 'x' }))).toBe(
			'UNSUPPORTED_STEP',
		)
	})

	it('密码/密钥目标 → UNSUPPORTED_STEP', () => {
		const flow = makeFlow([
			inputStep(
				'p1',
				'hunter2',
				makeRef({ attrs: { type: 'password', name: 'password' }, label: '密码' }),
			),
		])
		expect(errorCodeOf(() => applySuggestion(flow, { stepId: 'p1', name: 'pwd' }))).toBe(
			'UNSUPPORTED_STEP',
		)
	})

	it('空值 → EMPTY_VALUE', () => {
		const flow = makeFlow([inputStep('s1', '   ', emailTarget())])
		expect(errorCodeOf(() => applySuggestion(flow, { stepId: 's1', name: 'x' }))).toBe(
			'EMPTY_VALUE',
		)
	})

	it('已是模板 → VALUE_ALREADY_TEMPLATED', () => {
		const flow = makeFlow([inputStep('s1', '{{old}}', emailTarget())])
		expect(errorCodeOf(() => applySuggestion(flow, { stepId: 's1', name: 'x' }))).toBe(
			'VALUE_ALREADY_TEMPLATED',
		)
	})

	it('同一建议 apply 两次：第二次 VALUE_ALREADY_TEMPLATED，且原 flow 仍可再次 apply（幂等边界明确）', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])
		const input = { stepId: 's1', name: 'email', type: 'email' as const }

		const first = applySuggestion(flow, input)
		expect(errorCodeOf(() => applySuggestion(first.flow, input))).toBe('VALUE_ALREADY_TEMPLATED')
		// 原 flow 未变，仍然可以重新应用
		expect(applySuggestion(flow, input).changedStepIds).toEqual(['s1'])
	})
})

describe('applySuggestion —— applySameValue 批量', () => {
	it('同值步骤一起替换，不同值不动', () => {
		const flow = makeFlow([
			inputStep('s1', 'same@x.com', emailTarget()),
			inputStep('s2', 'same@x.com', emailTarget()),
			inputStep('s3', 'other@x.com', emailTarget()),
		])

		const result = applySuggestion(flow, {
			stepId: 's1',
			name: 'email',
			type: 'email',
			applySameValue: true,
		})

		expect(result.changedStepIds).toEqual(['s1', 's2'])
		expect(inputValue(result.flow, 's1')).toBe('{{email}}')
		expect(inputValue(result.flow, 's2')).toBe('{{email}}')
		expect(inputValue(result.flow, 's3')).toBe('other@x.com')
		expect(result.flow.variables).toHaveLength(1)
	})

	it('applySameValue=false 时只替换目标步骤', () => {
		const flow = makeFlow([
			inputStep('s1', 'same@x.com', emailTarget()),
			inputStep('s2', 'same@x.com', emailTarget()),
		])

		const result = applySuggestion(flow, { stepId: 's1', name: 'email', type: 'email' })
		expect(result.changedStepIds).toEqual(['s1'])
		expect(inputValue(result.flow, 's2')).toBe('same@x.com')
	})

	it('同值但目标是密码字段 → 跳过（不把明文密码参数化）', () => {
		const flow = makeFlow([
			inputStep('s1', 'shared123', emailTarget()),
			inputStep(
				'p1',
				'shared123',
				makeRef({ attrs: { type: 'password', name: 'password' }, label: '密码' }),
			),
		])

		const result = applySuggestion(flow, {
			stepId: 's1',
			name: 'token',
			applySameValue: true,
		})
		expect(result.changedStepIds).toEqual(['s1'])
		expect(inputValue(result.flow, 'p1')).toBe('shared123')
	})

	it('nested group 内的同值步骤也一起替换', () => {
		const flow = makeFlow([
			groupStep('g', [inputStep('g1', 'same@x.com', emailTarget())]),
			inputStep('s2', 'same@x.com', emailTarget()),
		])

		const result = applySuggestion(flow, {
			stepId: 'g1',
			name: 'email',
			type: 'email',
			applySameValue: true,
		})
		expect(result.changedStepIds).toEqual(['g1', 's2'])
	})
})

describe('applySuggestions —— 批量', () => {
	it('多条建议一次应用（不同变量），parseFlow 通过', () => {
		const flow = makeFlow([
			inputStep('s1', 'a@b.com', emailTarget()),
			inputStep('s2', '张三', makeRef({ label: '姓名' })),
		])

		const result = applySuggestions(flow, [
			{ stepId: 's1', name: 'email', type: 'email' },
			{ stepId: 's2', name: 'name' },
		])

		expect(result.changedStepIds).toEqual(['s1', 's2'])
		expect(result.flow.variables.map((item) => item.name).sort()).toEqual(['email', 'name'])
		expect(inputValue(result.flow, 's1')).toBe('{{email}}')
		expect(inputValue(result.flow, 's2')).toBe('{{name}}')
		expect(() => parseFlow(result.flow)).not.toThrow()
	})

	it('任一条非法 → 抛错（先整体校验，不返回半成品）', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])

		expect(() =>
			applySuggestions(flow, [
				{ stepId: 's1', name: 'email', type: 'email' },
				{ stepId: 'nope', name: 'x' },
			]),
		).toThrowError(SuggestError)
		// 纯函数：原 flow 完全不变
		expect(inputValue(flow, 's1')).toBe('a@b.com')
		expect(flow.variables).toHaveLength(0)
	})

	it('多条建议共用同名变量 → 只定义一次', () => {
		const flow = makeFlow([
			inputStep('s1', 'one', emailTarget()),
			inputStep('s2', 'two', emailTarget()),
		])

		const result = applySuggestions(flow, [
			{ stepId: 's1', name: 'shared' },
			{ stepId: 's2', name: 'shared' },
		])

		expect(result.flow.variables).toHaveLength(1)
		expect(inputValue(result.flow, 's1')).toBe('{{shared}}')
		expect(inputValue(result.flow, 's2')).toBe('{{shared}}')
	})

	it('空数组 → 原样克隆，不改动', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])
		const result = applySuggestions(flow, [])
		expect(result.changedStepIds).toEqual([])
		expect(result.flow).toEqual(flow)
		expect(result.flow).not.toBe(flow)
	})
})

describe('renameVariable', () => {
	function flowWithTemplates(): Flow {
		return makeFlow(
			[
				navigateStep('n1', 'https://x.test/{{old}}/p?q={{other}}&r={{old_suffix}}'),
				inputStep('i1', '{{old}}', emailTarget()),
				selectStep('sel1', '{{old}}', makeRef({ tag: 'select' })),
				selectStep('sel2', ['{{old}}', '{{other}}'], makeRef({ tag: 'select' })),
				uploadStep('u1', ['dir/{{ old }}.png']),
				dialogStep('d1', 'hello {{old}}'),
				groupStep('g', [inputStep('gi1', 'prefix-{{old}}')]),
			],
			[variable('old'), variable('other')],
		)
	}

	it('替换变量定义 + 所有模板字段（navigate.url/input/select string/select array/upload.files/dialog.promptText/group 内）', () => {
		const flow = flowWithTemplates()

		const next = renameVariable(flow, 'old', 'renamed')

		expect(next.variables.map((item) => item.name)).toEqual(['renamed', 'other'])
		expect(stepOf(next, 'n1')).toMatchObject({
			url: 'https://x.test/{{renamed}}/p?q={{other}}&r={{old_suffix}}',
		})
		expect(inputValue(next, 'i1')).toBe('{{renamed}}')
		expect(stepOf(next, 'sel1')).toMatchObject({ value: '{{renamed}}' })
		expect(stepOf(next, 'sel2')).toMatchObject({ value: ['{{renamed}}', '{{other}}'] })
		expect(stepOf(next, 'u1')).toMatchObject({ files: ['dir/{{renamed}}.png'] })
		expect(stepOf(next, 'd1')).toMatchObject({ promptText: 'hello {{renamed}}' })
		expect(inputValue(next, 'gi1')).toBe('prefix-{{renamed}}')

		// 原 flow 不变；改名后的 IR 仍合法
		expect(stepOf(flow, 'i1')).toMatchObject({ value: '{{old}}' })
		expect(() => parseFlow(next)).not.toThrow()
	})

	it('from == to → 返回深拷贝，不报错', () => {
		const flow = flowWithTemplates()
		const next = renameVariable(flow, 'old', 'old')
		expect(next).toEqual(flow)
		expect(next).not.toBe(flow)
	})

	it('from/to 前后空格会被 trim', () => {
		const next = renameVariable(flowWithTemplates(), ' old ', ' renamed ')
		expect(next.variables[0]?.name).toBe('renamed')
		expect(inputValue(next, 'i1')).toBe('{{renamed}}')
	})

	it('改名到已存在的变量 → NAME_CONFLICT', () => {
		expect(errorCodeOf(() => renameVariable(flowWithTemplates(), 'old', 'other'))).toBe(
			'NAME_CONFLICT',
		)
	})

	it('原变量不存在 → STEP_NOT_FOUND', () => {
		expect(errorCodeOf(() => renameVariable(flowWithTemplates(), 'nope', 'x'))).toBe(
			'STEP_NOT_FOUND',
		)
	})

	it('新名字非法 → INVALID_NAME', () => {
		expect(errorCodeOf(() => renameVariable(flowWithTemplates(), 'old', '1bad'))).toBe(
			'INVALID_NAME',
		)
	})
})
