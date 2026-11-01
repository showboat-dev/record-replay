import { describe, expect, it } from 'vitest'

import {
	applySelfHeals,
	bumpStats,
	describeCandidateForLog,
	escapeCssIdent,
	isStableId,
	pickCandidateFromFacts,
} from './index.js'
import { makeClickStep, makeFlow } from './testUtils.js'

describe('executor: 自愈候选择优', () => {
	it('isStableId 拒绝自动生成/随机 id', () => {
		expect(isStableId('submit-basic')).toBe(true)
		expect(isStableId('full-name')).toBe(true)
		expect(isStableId('12345')).toBe(false)
		expect(isStableId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false)
		expect(isStableId('field-123456')).toBe(false)
		expect(isStableId('react-1')).toBe(false)
		expect(isStableId('')).toBe(false)
	})

	it('escapeCssIdent 转义非法字符', () => {
		expect(escapeCssIdent('a:b')).toBe('a\\:b')
		expect(escapeCssIdent('plain-id')).toBe('plain-id')
	})

	it('优先级：data-testid > 稳定 id > role+name > name 属性 > aria-label > text', () => {
		expect(
			pickCandidateFromFacts({
				tag: 'button',
				testid: 'submit-basic',
				id: 'submit-basic',
				role: 'button',
				accessibleName: '提交表单',
			}),
		).toMatchObject({ kind: 'testid', value: 'submit-basic', source: 'ai' })

		expect(
			pickCandidateFromFacts({
				tag: 'button',
				id: 'submit-basic',
				role: 'button',
				accessibleName: '提交',
			}),
		).toMatchObject({ kind: 'css', value: '#submit-basic' })

		expect(
			pickCandidateFromFacts({ tag: 'button', role: 'button', accessibleName: '提交' }),
		).toEqual({
			kind: 'role',
			value: { role: 'button', name: '提交', exact: false },
			score: 0,
			source: 'ai',
		})

		expect(pickCandidateFromFacts({ tag: 'input', nameAttr: 'email' })).toMatchObject({
			kind: 'css',
			value: 'input[name="email"]',
		})

		expect(pickCandidateFromFacts({ tag: 'button', ariaLabel: '关闭' })).toMatchObject({
			kind: 'css',
			value: '[aria-label="关闭"]',
		})

		expect(pickCandidateFromFacts({ tag: 'button', text: '确定' })).toMatchObject({
			kind: 'text',
			value: '确定',
		})
	})

	it('不稳定 id 被跳过，回退到下一优先级', () => {
		const candidate = pickCandidateFromFacts({
			tag: 'button',
			id: 'react-12345',
			role: 'button',
			accessibleName: '提交',
		})
		expect(candidate?.kind).toBe('role')
	})

	it('已有候选值去重（不重复写回同一条）', () => {
		expect(pickCandidateFromFacts({ tag: 'button', testid: 'submit' }, ['submit'])).toBeNull()
	})

	it('推不出任何候选时返回 null', () => {
		expect(pickCandidateFromFacts({ tag: 'div' })).toBeNull()
	})

	it('describeCandidateForLog 可读', () => {
		expect(
			describeCandidateForLog({ kind: 'testid', value: 'x', score: 0, source: 'record' }),
		).toBe('testid(x)')
		expect(
			describeCandidateForLog({
				kind: 'role',
				value: { role: 'button', name: '提交' },
				score: 0,
				source: 'record',
			}),
		).toBe('role(button, name=提交)')
	})
})

describe('executor: 自愈写回（默认不写，applySelfHeals 是纯函数）', () => {
	it('version +1、候选追加到最后、score = max+1、selfHealed 追加', () => {
		const flow = makeFlow([makeClickStep()])
		const next = applySelfHeals(flow, [
			{
				stepId: 'click-submit',
				level: 'L4',
				from: 'testid(submit-basic)',
				to: 'css(#submit-basic)',
				at: '2024-01-01T00:00:00.000Z',
				confidence: 0.9,
				needsReview: false,
				candidate: { kind: 'css', value: '#submit-basic', score: 0, source: 'ai' },
			},
		])

		expect(next.version).toBe(2)
		const step = next.steps[0]
		expect(step?.kind).toBe('click')
		if (step?.kind === 'click') {
			expect(step.target.candidates).toHaveLength(3)
			const appended = step.target.candidates[2]
			expect(appended).toMatchObject({
				kind: 'css',
				value: '#submit-basic',
				source: 'ai',
				score: 101,
			})
			// 保持 score 升序（契约校验要求）
			const scores = step.target.candidates.map((c) => c.score)
			expect([...scores].sort((a, b) => a - b)).toEqual(scores)
		}
		expect(next.selfHealed).toHaveLength(1)
		expect(next.selfHealed[0]).toMatchObject({
			stepId: 'click-submit',
			level: 'L4',
			needsReview: false,
		})
		// 原 flow 不被修改
		expect(flow.version).toBe(1)
		expect(flow.selfHealed).toHaveLength(0)
	})

	it('没有 candidate 的自愈只留记录，不改 steps', () => {
		const flow = makeFlow([makeClickStep()])
		const next = applySelfHeals(flow, [
			{
				stepId: 'click-submit',
				level: 'L4',
				from: 'testid(x)',
				at: '2024-01-01T00:00:00.000Z',
				needsReview: true,
			},
		])
		// 纯记录不升版本（避免版本噪音），但记录要留下
		expect(next.version).toBe(1)
		expect(next.selfHealed).toHaveLength(1)
	})

	it('同一候选不重复追加', () => {
		const flow = makeFlow([makeClickStep()])
		const heal = {
			stepId: 'click-submit',
			level: 'L4' as const,
			from: 'testid(submit-basic)',
			at: '2024-01-01T00:00:00.000Z',
			needsReview: false,
			candidate: {
				kind: 'testid' as const,
				value: 'submit-basic',
				score: 0,
				source: 'ai' as const,
			},
		}
		const next = applySelfHeals(flow, [heal])
		const step = next.steps[0]
		if (step?.kind === 'click') expect(step.target.candidates).toHaveLength(2)
	})

	it('嵌套 group 里的 stepId 用 / 连接，能定位到', () => {
		const flow = makeFlow([
			{
				id: 'grp',
				kind: 'group',
				label: '分组',
				steps: [makeClickStep('inner-click')],
			},
		])
		const next = applySelfHeals(flow, [
			{
				stepId: 'grp/inner-click',
				level: 'L4',
				from: 'testid(a)',
				at: '2024-01-01T00:00:00.000Z',
				needsReview: false,
				candidate: { kind: 'testid', value: 'inner', score: 0, source: 'ai' },
			},
		])
		const group = next.steps[0]
		expect(group?.kind).toBe('group')
		if (group?.kind === 'group') {
			const inner = group.steps[0]
			if (inner?.kind === 'click') expect(inner.target.candidates).toHaveLength(3)
		}
	})

	it('bumpStats 累加 runs/passes', () => {
		const flow = makeFlow([makeClickStep()], {
			stats: { runs: 2, passes: 1, lastRunAt: '2024-01-01T00:00:00.000Z' },
		})
		const next = bumpStats(flow, true, '2024-02-02T00:00:00.000Z')
		expect(next.stats).toEqual({ runs: 3, passes: 2, lastRunAt: '2024-02-02T00:00:00.000Z' })
		const failed = bumpStats(next, false, '2024-03-03T00:00:00.000Z')
		expect(failed.stats).toEqual({ runs: 4, passes: 2, lastRunAt: '2024-03-03T00:00:00.000Z' })
	})
})
