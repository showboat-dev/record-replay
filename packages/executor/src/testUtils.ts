/**
 * 测试用的最小合法 IR 构造器（不是 vitest 测试文件，不会被 pnpm test 收集）。
 * 用 schema 的 parseFlow 构造，保证 fixture 本身一定通过契约校验。
 */
import { parseFlow, type ElementRef, type Flow, type Step } from '@rr/schema'

export function makeRef(overrides: Partial<ElementRef> = {}): ElementRef {
	const base: ElementRef = {
		observed: {
			tag: 'button',
			attributes: { id: 'submit-basic', 'data-testid': 'submit-basic' },
			text: '提交表单',
			rect: { x: 10, y: 20, width: 80, height: 32 },
			scroll: { x: 0, y: 0 },
			viewport: { width: 1440, height: 900 },
			dpr: 1,
			recordedAt: 1_700_000_000_000,
		},
		candidates: [
			{ kind: 'testid', value: 'submit-basic', score: 2, source: 'record' },
			{ kind: 'role', value: { role: 'button', name: '提交表单' }, score: 100, source: 'record' },
		],
		fingerprint: {
			tag: 'button',
			role: 'button',
			accessibleName: '提交表单',
			attrs: { id: 'submit-basic', 'data-testid': 'submit-basic' },
			stableHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		},
		frame: { path: [] },
	}
	return { ...base, ...overrides }
}

export function makeClickStep(id = 'click-submit', ref: ElementRef = makeRef()): Step {
	return {
		id,
		kind: 'click',
		target: ref,
		button: 'left',
		clickCount: 1,
		modifiers: [],
	}
}

export function makeFlow(steps: Step[] = [makeClickStep()], overrides: Record<string, unknown> = {}): Flow {
	return parseFlow({
		schemaVersion: 1,
		id: 'basic-flow',
		title: '基础表单',
		version: 1,
		createdAt: '2024-01-01T00:00:00.000Z',
		meta: {
			env: {
				startUrl: 'http://127.0.0.1:5173/basic',
				viewport: { width: 1440, height: 900 },
				dpr: 1,
			},
			recorder: { name: 'test', version: '0.0.1' },
		},
		variables: [],
		steps,
		selfHealed: [],
		...overrides,
	})
}
