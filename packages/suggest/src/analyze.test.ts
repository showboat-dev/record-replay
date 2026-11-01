/**
 * analyze.ts 单测（表驱动）：信号/负向/排除项/同值 group/命名冲突/类型推断/排序/截断。
 * 规则出处：docs/parameterization.md §2/§3。
 */
import { describe, expect, it } from 'vitest'

import { analyzeFlow } from './analyze.js'
import {
	clickStep,
	dialogStep,
	groupStep,
	inputStep,
	makeFlow,
	makeRef,
	navigateStep,
	selectStep,
	switchTabStep,
	uploadStep,
	variable,
} from './test-helpers.js'

function emailTarget(label = '邮箱') {
	return makeRef({ attrs: { type: 'email', placeholder: '请输入邮箱', name: 'email' }, label })
}

describe('analyzeFlow —— 候选与信号', () => {
	it('email 输入命中 type + 值格式 + 字段词 → high，理由中文可读', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])

		const result = analyzeFlow(flow)

		expect(result.suggestions).toHaveLength(1)
		const suggestion = result.suggestions[0]!
		expect(suggestion).toMatchObject({
			stepId: 's1',
			kind: 'input',
			currentValue: 'a@b.com',
			suggestedName: 'email',
			suggestedType: 'email',
			confidence: 'high',
		})
		expect(suggestion.reasons).toEqual([
			'输入类型为 email（+3）',
			'值符合邮箱格式（+2）',
			'字段名命中业务词「邮箱」（+3）',
		])
	})

	it('恰好 5 分 → high（type + 值格式）', () => {
		const flow = makeFlow([
			inputStep('s1', 'a@b.com', makeRef({ attrs: { type: 'email' }, label: 'Contact' })),
		])

		const suggestion = analyzeFlow(flow).suggestions[0]!
		expect(suggestion.confidence).toBe('high')
		expect(suggestion.suggestedName).toBe('contact')
		expect(suggestion.suggestedType).toBe('email')
	})

	it('恰好 3 分 → medium（只命中字段词）', () => {
		const flow = makeFlow([inputStep('s1', '张三', makeRef({ label: '姓名' }))])

		const suggestion = analyzeFlow(flow).suggestions[0]!
		expect(suggestion.confidence).toBe('medium')
		expect(suggestion.reasons).toEqual(['字段名命中业务词「姓名」（+3）'])
		expect(suggestion.suggestedName).toBe('name')
		expect(suggestion.suggestedType).toBe('string')
	})

	it('数量词 + 短数字 → +1（3+1=4 medium）', () => {
		const flow = makeFlow([inputStep('s1', '2', makeRef({ label: '数量' }))])

		const suggestion = analyzeFlow(flow).suggestions[0]!
		expect(suggestion.confidence).toBe('medium')
		expect(suggestion.suggestedType).toBe('number')
		expect(suggestion.reasons.join('|')).toContain('数量词')
	})

	it('select(string) 也是候选，kind=select', () => {
		const flow = makeFlow([selectStep('s1', '上海', makeRef({ tag: 'select', label: '城市' }))])

		const suggestion = analyzeFlow(flow).suggestions[0]!
		expect(suggestion).toMatchObject({ stepId: 's1', kind: 'select', suggestedName: 'city' })
		expect(suggestion.confidence).toBe('medium')
	})

	it('只有 data-testid 时也能靠 testid 语义召回（Studio 集成 fixture 场景）', () => {
		const flow = makeFlow([
			inputStep('s1', 'zhang@example.com', makeRef({ attrs: { 'data-testid': 'field-email' } })),
			inputStep('s2', '张三', makeRef({ attrs: { 'data-testid': 'field-full-name' } })),
		])

		const result = analyzeFlow(flow)
		expect(result.suggestions.map((item) => item.stepId)).toEqual(['s1', 's2'])
		expect(result.suggestions[0]!.confidence).toBe('high')
		expect(result.suggestions[1]!.confidence).toBe('medium')
	})

	it('无信号 → weak 默认不返回，includeWeak 才返回', () => {
		const flow = makeFlow([inputStep('s1', 'bar', makeRef({ label: 'foo' }))])

		const byDefault = analyzeFlow(flow)
		expect(byDefault.suggestions).toHaveLength(0)

		const withWeak = analyzeFlow(flow, { includeWeak: true })
		expect(withWeak.suggestions).toHaveLength(1)
		expect(withWeak.suggestions[0]!.confidence).toBe('weak')
		expect(withWeak.suggestions[0]!.reasons.join('')).toContain('未命中明确参数化信号')
	})

	it.each([
		['2026-01-01', '日期'],
		['13800138000', '手机号'],
		['¥1,200.00', '金额'],
		['AB123456789', '长编号'],
	])('值格式 %s → +2（weak）且理由含「%s」', (value, label) => {
		const flow = makeFlow([inputStep('s1', value, makeRef({ label: 'bar' }))])

		const suggestion = analyzeFlow(flow, { includeWeak: true }).suggestions[0]!
		expect(suggestion.confidence).toBe('weak')
		expect(suggestion.reasons.join('|')).toContain(`${label}格式（+2）`)
	})
})

describe('analyzeFlow —— 同值 group', () => {
	it('同一值出现在 2 个候选步骤 → +2 且生成 group', () => {
		const flow = makeFlow([
			inputStep('s1', 'a@b.com', emailTarget()),
			inputStep('s2', 'a@b.com', emailTarget()),
		])

		const result = analyzeFlow(flow)

		expect(result.suggestions).toHaveLength(2)
		for (const suggestion of result.suggestions) {
			expect(suggestion.group).toEqual({ value: 'a@b.com', stepIds: ['s1', 's2'] })
			expect(suggestion.reasons.join('|')).toContain('同一值在 2 个步骤中重复出现（+2）')
		}
	})

	it('值不同则没有 group', () => {
		const flow = makeFlow([
			inputStep('s1', 'a@b.com', emailTarget()),
			inputStep('s2', 'c@d.com', emailTarget()),
		])

		const result = analyzeFlow(flow)
		expect(result.suggestions.every((item) => item.group === undefined)).toBe(true)
	})
})

describe('analyzeFlow —— 排除项（进 skipped，中文原因）', () => {
	it('password / 空值 / 已模板 / 多选 select / upload 全部排除', () => {
		const flow = makeFlow([
			inputStep(
				'pwd',
				'secret123',
				makeRef({ attrs: { type: 'password', name: 'password' }, label: '密码' }),
			),
			inputStep('empty', '   '),
			inputStep('tpl', '{{email}}', emailTarget()),
			selectStep('multi', ['a', 'b'], makeRef({ tag: 'select', label: '城市' })),
			uploadStep('file', ['a.png']),
		])

		const result = analyzeFlow(flow)

		expect(result.suggestions).toHaveLength(0)
		const reasons = new Map(result.skipped.map((item) => [item.stepId, item.reason]))
		expect(reasons.get('pwd')).toContain('密码')
		expect(reasons.get('empty')).toContain('为空')
		expect(reasons.get('tpl')).toContain('模板')
		expect(reasons.get('multi')).toContain('多选')
		expect(reasons.get('file')).toContain('上传')
	})

	it.each([
		['autocomplete=current-password', { attrs: { autocomplete: 'current-password' } }],
		['name=passwd', { attrs: { name: 'passwd' } }],
		['label=密码', { label: '密码' }],
	] as const)('密码类目标（%s）被排除', (_label, refOptions) => {
		const flow = makeFlow([inputStep('s1', 'hunter2', makeRef({ ...refOptions }))])

		const result = analyzeFlow(flow)
		expect(result.suggestions).toHaveLength(0)
		expect(result.skipped[0]?.stepId).toBe('s1')
		expect(result.skipped[0]?.reason).toContain('密码')
	})

	it('非数据步骤进 skipped，原因按步骤类型给出', () => {
		const flow = makeFlow([
			clickStep('c1'),
			navigateStep('n1', 'https://app.test/'),
			dialogStep('d1', '确认吗？'),
			switchTabStep('t1'),
		])

		const result = analyzeFlow(flow)
		expect(result.suggestions).toHaveLength(0)
		const reasons = new Map(result.skipped.map((item) => [item.stepId, item.reason]))
		expect(reasons.get('c1')).toContain('点击')
		expect(reasons.get('n1')).toContain('导航')
		expect(reasons.get('d1')).toContain('对话框')
		expect(reasons.get('t1')).toContain('标签页')
	})

	it('weak 候选不会写进 skipped（只是默认不展示）', () => {
		const flow = makeFlow([inputStep('s1', 'bar', makeRef({ label: 'foo' }))])
		expect(analyzeFlow(flow).skipped).toHaveLength(0)
	})
})

describe('analyzeFlow —— 负向信号', () => {
	it.each([
		['label=搜索订单', makeRef({ label: '搜索订单' })],
		['aria-autocomplete', makeRef({ label: '客户', attrs: { 'aria-autocomplete': 'list' } })],
		[
			'combobox + listbox',
			makeRef({ label: '客户', attrs: { role: 'combobox', 'aria-haspopup': 'listbox' } }),
		],
	])('搜索/筛选特征（%s）扣 4 分 → weak', (_label, target) => {
		const flow = makeFlow([inputStep('s1', 'abc123', target)])

		const suggestion = analyzeFlow(flow, { includeWeak: true }).suggestions[0]!
		expect(suggestion.confidence).toBe('weak')
		expect(suggestion.reasons.join('|')).toContain('搜索/筛选框')
	})

	it('textarea + 泛化文本 → -2 分（weak）', () => {
		const flow = makeFlow([inputStep('s1', '随便', makeRef({ tag: 'textarea', label: '备注' }))])

		const suggestion = analyzeFlow(flow, { includeWeak: true }).suggestions[0]!
		expect(suggestion.confidence).toBe('weak')
		expect(suggestion.reasons.join('|')).toContain('泛化文本域')
	})
})

describe('analyzeFlow —— 命名查重', () => {
	it('与 flow.variables 查重：email / email_2 / email_3', () => {
		const flow = makeFlow(
			[inputStep('s1', 'a@b.com', emailTarget()), inputStep('s2', 'c@d.com', emailTarget())],
			[variable('email', 'email')],
		)

		const names = analyzeFlow(flow).suggestions.map((item) => item.suggestedName)
		expect(names).toEqual(['email_2', 'email_3'])
	})

	it('同一批建议之间也查重（同字段两次 → name / name_2）', () => {
		const flow = makeFlow([
			inputStep('s1', '张三', makeRef({ label: '姓名' })),
			inputStep('s2', '李四', makeRef({ label: '姓名' })),
		])

		const names = analyzeFlow(flow).suggestions.map((item) => item.suggestedName)
		expect(names).toEqual(['name', 'name_2'])
	})
})

describe('analyzeFlow —— 排序 / 截断 / 结构', () => {
	it('先按 confidence（high→medium），同置信度按 stepIndex', () => {
		const flow = makeFlow([
			inputStep('s1', '张三', makeRef({ label: '姓名' })), // medium
			inputStep('s2', 'a@b.com', emailTarget()), // high
			inputStep('s3', 'x', makeRef({ label: '电话' })), // medium
		])

		const result = analyzeFlow(flow)
		expect(result.suggestions.map((item) => item.stepId)).toEqual(['s2', 's1', 's3'])
		expect(result.suggestions.map((item) => item.confidence)).toEqual(['high', 'medium', 'medium'])
	})

	it('maxSuggestions 截断返回条数', () => {
		const flow = makeFlow([
			inputStep('s1', 'a@b.com', emailTarget()),
			inputStep('s2', 'c@d.com', emailTarget()),
			inputStep('s3', 'e@f.com', emailTarget()),
		])

		const result = analyzeFlow(flow, { maxSuggestions: 2 })
		expect(result.suggestions).toHaveLength(2)
		expect(result.suggestions.map((item) => item.stepId)).toEqual(['s1', 's2'])
	})

	it('target 信息完整（label/placeholder/nameAttr/inputType/pageIndex/stepIndex）', () => {
		const target = makeRef({
			attrs: { type: 'email', placeholder: '请输入邮箱', name: 'user_email' },
			label: '邮箱',
		})
		const flow = makeFlow([inputStep('s1', 'a@b.com', target, 2)])

		const suggestion = analyzeFlow(flow).suggestions[0]!
		expect(suggestion.target).toEqual({
			tag: 'input',
			label: '邮箱',
			placeholder: '请输入邮箱',
			nameAttr: 'user_email',
			inputType: 'email',
			stepIndex: 0,
			pageIndex: 2,
		})
	})

	it('nested group 内的步骤用 flatten 下标，group 本身不进 skipped', () => {
		const flow = makeFlow([
			groupStep('g', [
				inputStep('g1', 'a@b.com', emailTarget()),
				inputStep('g2', 'c@d.com', emailTarget()),
			]),
			inputStep('s3', 'e@f.com', emailTarget()),
		])

		const result = analyzeFlow(flow)
		expect(result.suggestions.map((item) => item.target.stepIndex)).toEqual([1, 2, 3])
		expect(result.skipped).toHaveLength(0)
	})

	it('generatedAt 是 ISO 字符串，flowVersion 透传', () => {
		const flow = makeFlow([inputStep('s1', 'a@b.com', emailTarget())])
		flow.version = 7

		const result = analyzeFlow(flow)
		expect(result.flowVersion).toBe(7)
		expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt)
	})
})
