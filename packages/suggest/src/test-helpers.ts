/**
 * 仅测试使用的工厂（不参与运行时逻辑，也不会从 index.ts 导出）。
 * 用来把 Flow / Step / ElementRef 造得尽量小但仍能通过 parseFlow。
 */
import type { ElementRef, Flow, Step, Variable } from '@rr/schema'

export interface MakeRefOptions {
	tag?: string
	attrs?: Record<string, string>
	label?: string
	nearbyText?: string[]
	description?: string
}

function plainAttrs(options: MakeRefOptions): Record<string, string> {
	return { ...(options.attrs ?? {}) }
}

export function makeRef(options: MakeRefOptions = {}): ElementRef {
	const tag = options.tag ?? 'input'
	const attrs = plainAttrs(options)
	const candidates = options.label
		? [{ kind: 'label' as const, value: options.label, score: 0, source: 'record' as const }]
		: [{ kind: 'testid' as const, value: `testid-${tag}`, score: 0, source: 'record' as const }]

	return {
		observed: {
			tag,
			attributes: attrs,
			rect: { x: 0, y: 0, width: 120, height: 32 },
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 2,
			recordedAt: 1_700_000_000_000,
		},
		candidates,
		fingerprint: {
			tag,
			attrs: { ...attrs },
			stableHash: `hash-${tag}-${Object.values(attrs).join('-')}`,
		},
		frame: { path: [] },
		...(options.label ? { description: options.label } : {}),
		...(options.nearbyText ? { nearbyText: options.nearbyText } : {}),
	}
}

export function inputStep(
	id: string,
	value: string,
	target?: ElementRef,
	pageIndex?: number,
): Step {
	const base = {
		kind: 'input' as const,
		id,
		target: target ?? makeRef({ attrs: { type: 'text' } }),
		value,
		clear: true as const,
	}
	return typeof pageIndex === 'number' ? { ...base, page: { index: pageIndex } } : base
}

export function selectStep(id: string, value: string | string[], target?: ElementRef): Step {
	return {
		kind: 'select',
		id,
		target: target ?? makeRef({ tag: 'select' }),
		value,
	}
}

export function uploadStep(id: string, files: string[]): Step {
	return { kind: 'upload', id, target: makeRef({ tag: 'input', attrs: { type: 'file' } }), files }
}

export function clickStep(id: string): Step {
	return {
		kind: 'click',
		id,
		target: makeRef({ tag: 'button', label: '提交' }),
		button: 'left',
		clickCount: 1,
		modifiers: [],
	}
}

export function navigateStep(id: string, url: string): Step {
	return { kind: 'navigate', id, url }
}

export function dialogStep(id: string, promptText?: string): Step {
	return {
		kind: 'dialog',
		id,
		action: 'accept',
		...(typeof promptText === 'string' ? { promptText } : {}),
	}
}

export function switchTabStep(id: string, index = 1): Step {
	return { kind: 'switchTab', id, index }
}

export function groupStep(id: string, steps: Step[], label = '分组'): Step {
	return { kind: 'group', id, label, steps }
}

export function variable(name: string, type: Variable['type'] = 'string'): Variable {
	return { name, type, secret: false, source: 'input' }
}

export function makeFlow(steps: Step[], variables: Variable[] = []): Flow {
	return {
		schemaVersion: 1,
		id: 'flow_test',
		title: '测试流程',
		version: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		meta: {
			env: { startUrl: 'https://app.test/', viewport: { width: 1440, height: 900 }, dpr: 2 },
			recorder: { name: '@rr/recorder', version: '0.0.1' },
		},
		variables,
		steps,
		selfHealed: [],
	}
}
