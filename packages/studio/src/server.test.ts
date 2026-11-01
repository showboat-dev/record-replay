import { describe, expect, it } from 'vitest'

import type { Step } from '@rr/schema'

import { reasonOf, stepTitle, summarize } from './server.js'

function step(partial: Record<string, unknown>): Step {
	return { id: 's1', ...partial } as unknown as Step
}

describe('studio: 人话步骤标题', () => {
	it('常见动作都有可读中文', () => {
		expect(stepTitle(step({ kind: 'navigate', url: 'https://x.test/login' }))).toContain('打开')
		expect(
			stepTitle(
				step({
					kind: 'click',
					target: { description: '按钮「保存」', observed: { tag: 'button' } },
				}),
			),
		).toContain('点击')
		expect(
			stepTitle(
				step({
					kind: 'input',
					target: { description: '输入框「姓名」', observed: { tag: 'input' } },
					value: 'alice',
				}),
			),
		).toContain('alice')
		expect(stepTitle(step({ kind: 'wait', condition: 'element' }))).toContain('等待')
	})

	it('新能力步骤有人话标题：对话框 / 切标签页 / 标签页前缀', () => {
		expect(stepTitle(step({ kind: 'dialog', action: 'accept' }))).toContain('弹窗')
		expect(stepTitle(step({ kind: 'switchTab', index: 1 }))).toContain('第 2 个标签页')
		const onTab = stepTitle(
			step({
				kind: 'click',
				target: { description: '按钮「提交」', observed: { tag: 'button' } },
				page: { index: 1 },
			}),
		)
		expect(onTab.startsWith('标签页 2：')).toBe(true)
	})

	it('未知/新动作不会崩', () => {
		expect(stepTitle(step({ kind: 'future-action' }))).toBeTruthy()
	})
})

describe('studio: 错误码 → 人话', () => {
	it('已知错误码映射成人话', () => {
		const result = {
			stepId: 's1',
			kind: 'click',
			status: 'fail',
			ms: 1,
			error: { code: 'ELEMENT_NOT_FOUND', message: 'x' },
		}
		expect(reasonOf(result as never)).toContain('找不到')
	})

	it('未知错误码回落到原始 message', () => {
		const result = {
			stepId: 's1',
			kind: 'click',
			status: 'fail',
			ms: 1,
			error: { code: 'SOMETHING_NEW', message: '原始错误' },
		}
		expect(reasonOf(result as never)).toBe('原始错误')
	})
})

describe('studio: 步骤摘要', () => {
	it('summary 包含 index/id/title', () => {
		const flow = {
			steps: [
				{ id: 's1', kind: 'navigate', url: 'https://x.test/' },
				{ id: 's2', kind: 'click', target: { description: '按钮', observed: { tag: 'button' } } },
			],
		} as never
		const list = summarize(flow)
		expect(list).toHaveLength(2)
		expect(list[0]).toMatchObject({ index: 0, id: 's1' })
		expect(list[1]?.title).toContain('点击')
	})
})
