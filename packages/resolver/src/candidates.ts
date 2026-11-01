/**
 * Candidate → Playwright Locator 的映射（L1 的唯一来源）。
 *
 * 设计取舍：
 * - 只用 Playwright 官方语义定位器（getByTestId/Role/Label/Text）+ css/xpath 兜底；
 * - 不在这里做任何"重试/超时"逻辑，找得到找不到由 l1.ts 统一处理；
 * - xpath 允许 `xpath=...` 前缀，也允许裸 `/html/body/...`。
 */
import type { Candidate } from '@rr/schema'
import type { Locator, Page } from 'playwright'

import type { Scope } from './types.js'

/** Playwright 内部 role 联合类型 */
type AriaRoleArg = Parameters<Page['getByRole']>[0]

export function isXPathValue(value: string): boolean {
	return value.startsWith('xpath=') || value.startsWith('/') || value.startsWith('(')
}

/** 把 candidate 变成 locator（不执行任何查询） */
export function candidateLocator(scope: Scope, candidate: Candidate): Locator {
	const { kind, value } = candidate

	if (typeof value !== 'string') {
		// 对象形态目前只用于 role: {role, name?, exact?}
		if (kind !== 'role') {
			throw new Error(`candidate 的对象形态只支持 role，收到 kind=${kind}`)
		}
		const opts: { name?: string; exact?: boolean } = {}
		if (value.name !== undefined) opts.name = value.name
		if (value.exact !== undefined) opts.exact = value.exact
		return scope.getByRole(value.role as AriaRoleArg, opts)
	}

	switch (kind) {
		case 'testid':
			return scope.getByTestId(value)
		case 'role':
			return scope.getByRole(value as AriaRoleArg)
		case 'label':
			return scope.getByLabel(value)
		case 'text':
			return scope.getByText(value)
		case 'css':
			return scope.locator(value)
		case 'xpath':
			return scope.locator(isXPathValue(value) ? value : `xpath=${value}`)
		default:
			throw new Error(`未知 candidate.kind: ${String(kind)}`)
	}
}

/** 人眼可读的候选描述，写日志用 */
export function describeCandidate(candidate: Candidate): string {
	if (typeof candidate.value === 'string') {
		return `${candidate.kind}(${candidate.value})`
	}
	const name = candidate.value.name ? `, name="${candidate.value.name}"` : ''
	return `role(${candidate.value.role}${name})`
}
