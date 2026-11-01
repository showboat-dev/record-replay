/**
 * Step 树的展开与映射（group 是嵌套结构，执行/写回都需要按 stepId 定位）。
 *
 * stepId 约定：顶层就是 step.id；group 内的用 `/` 连接，例如 `checkout/click-pay`，
 * 保证在整个 flow 内唯一（result.json / selfHealed 用它回指）。
 */
import type { Step } from '@rr/schema'

export interface FlatStep {
	step: Step
	stepId: string
	/** 在展开序列里的序号（artifact 目录名用） */
	index: number
	/** 嵌套深度，0 = 顶层 */
	depth: number
}

export function stepIdOf(prefix: string, id: string): string {
	return prefix.length > 0 ? `${prefix}/${id}` : id
}

/** 深度优先展开（group 不产出自身条目，只展开子步骤）；index 全局连续 */
export function flattenSteps(steps: Step[], prefix = '', depth = 0): FlatStep[] {
	const out: FlatStep[] = []
	const visit = (list: Step[], listPrefix: string, listDepth: number): void => {
		for (const step of list) {
			const stepId = stepIdOf(listPrefix, step.id)
			if (step.kind === 'group') {
				visit(step.steps, stepId, listDepth + 1)
				continue
			}
			out.push({ step, stepId, index: out.length, depth: listDepth })
		}
	}
	visit(steps, prefix, depth)
	return out
}

/** 不可变地映射每个非 group step（保留 group 结构） */
export function mapSteps(
	steps: Step[],
	fn: (step: Step, stepId: string) => Step,
	prefix = '',
): Step[] {
	return steps.map((step) => {
		const stepId = stepIdOf(prefix, step.id)
		if (step.kind === 'group') {
			return { ...step, steps: mapSteps(step.steps, fn, stepId) }
		}
		return fn(step, stepId)
	})
}

/** flow 里是否出现某种 step（用于提前决定策略，例如有没有 dialog 步骤 → 对话框手动模式） */
export function hasStepKind(steps: Step[], kind: Step['kind']): boolean {
	for (const step of steps) {
		if (step.kind === kind) return true
		if (step.kind === 'group' && hasStepKind(step.steps, kind)) return true
	}
	return false
}

/** 按 stepId 找到 step（找不到返回 undefined） */
export function findStep(steps: Step[], stepId: string, prefix = ''): Step | undefined {
	for (const step of steps) {
		const id = stepIdOf(prefix, step.id)
		if (step.kind === 'group') {
			const found = findStep(step.steps, stepId, id)
			if (found) return found
			continue
		}
		if (id === stepId) return step
	}
	return undefined
}
