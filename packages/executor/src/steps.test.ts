import { describe, expect, it } from 'vitest'

import { findStep, flattenSteps, mapSteps, stepIdOf } from './index.js'
import { makeClickStep } from './testUtils.js'

describe('executor: step 树展开', () => {
	it('flattenSteps 展开 group，stepId 用 / 连接，index 连续', () => {
		const flat = flattenSteps([
			makeClickStep('a'),
			{
				id: 'grp',
				kind: 'group',
				label: '分组',
				steps: [
					makeClickStep('b'),
					{ id: 'nested', kind: 'group', label: 'n', steps: [makeClickStep('c')] },
				],
			},
			makeClickStep('d'),
		])
		expect(flat.map((f) => f.stepId)).toEqual(['a', 'grp/b', 'grp/nested/c', 'd'])
		expect(flat.map((f) => f.index)).toEqual([0, 1, 2, 3])
		expect(flat.map((f) => f.depth)).toEqual([0, 1, 2, 0])
	})

	it('group 自身不产出执行条目', () => {
		const flat = flattenSteps([{ id: 'g', kind: 'group', label: 'g', steps: [] }])
		expect(flat).toEqual([])
	})

	it('stepIdOf 顶层不加前缀', () => {
		expect(stepIdOf('', 'x')).toBe('x')
		expect(stepIdOf('g', 'x')).toBe('g/x')
	})

	it('mapSteps 不可变，并保留 group 结构', () => {
		const steps = [
			makeClickStep('a'),
			{ id: 'grp', kind: 'group' as const, label: 'g', steps: [makeClickStep('b')] },
		]
		const mapped = mapSteps(steps, (step, stepId) =>
			step.kind === 'click'
				? { ...step, button: stepId === 'grp/b' ? ('right' as const) : step.button }
				: step,
		)
		expect(
			steps[1]?.kind === 'group' && steps[1].steps[0]?.kind === 'click'
				? steps[1].steps[0].button
				: null,
		).toBe('left')
		const group = mapped[1]
		expect(group?.kind).toBe('group')
		if (group?.kind === 'group') {
			const inner = group.steps[0]
			expect(inner?.kind === 'click' ? inner.button : null).toBe('right')
		}
	})

	it('findStep 能按 stepId 找到嵌套步骤', () => {
		const steps = [
			{ id: 'grp', kind: 'group' as const, label: 'g', steps: [makeClickStep('inner')] },
			makeClickStep('top'),
		]
		expect(findStep(steps, 'grp/inner')?.id).toBe('inner')
		expect(findStep(steps, 'top')?.id).toBe('top')
		expect(findStep(steps, 'nope')).toBeUndefined()
	})
})
