/**
 * 自愈写回（纯逻辑，可单测）。
 *
 * 计划硬性要求：**默认不写回**，只有 `opts.writeBack === true` 才动 flow 文件；
 * 写回时 version+1、追加 selfHealed[]，并 `saveFlow(..., {backup: true})`（由 index.ts 负责落盘）。
 *
 * 写回什么？AI 只给了一个 aria-ref（同一 session 内有效），直接存 ref 下次回放会失效。
 * 所以这里把 ref 指向元素**当场转成语义候选**（testid > id > role+name > name 属性 > text），
 * 作为最后一条候选追加（score 取现有最大值 +1 → L1 会最后才试它）。
 */
import type { Candidate, Step } from '@rr/schema'

import { mapSteps } from './steps.js'
import type { SelfHealRecord } from './types.js'

/** AI 命中的元素的关键事实（由 locator.evaluate 在页面内取，已做归一化） */
export interface ElementFacts {
	tag: string
	id?: string
	testid?: string
	role?: string
	accessibleName?: string
	nameAttr?: string
	text?: string
	ariaLabel?: string
	placeholder?: string
}

function collapse(value: string | undefined): string | undefined {
	if (value === undefined) return undefined
	const trimmed = value.replace(/\s+/g, ' ').trim()
	return trimmed.length > 0 ? trimmed : undefined
}

/** CSS ident 转义（只需要处理 id 里常见的非法字符） */
export function escapeCssIdent(value: string): string {
	return value.replace(/[^\w-]/g, (ch) => `\\${ch}`)
}

/** 看起来像随机生成的 id（含长数字串/UUID）就认为不稳定，不写回 */
export function isStableId(id: string): boolean {
	if (id.length === 0 || id.length > 64) return false
	if (/^\d+$/.test(id)) return false
	if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false
	if (/\d{5,}/.test(id)) return false
	if (/(^|[-_])(react|vue|ng|ember|svelte)[-_]?\d*/i.test(id)) return false
	return true
}

/**
 * 从元素事实推出可写回的候选（按稳定性优先级）。推不出来返回 null。
 * `usedValues` 是 flow 里已有的候选值，用于去重。
 */
export function pickCandidateFromFacts(
	facts: ElementFacts,
	usedValues: ReadonlyArray<string> = [],
): Candidate | null {
	const used = new Set(usedValues.map((v) => v.trim()))
	const push = (candidate: Candidate): Candidate | null => {
		const key =
			typeof candidate.value === 'string'
				? candidate.value.trim()
				: `${candidate.value.role}:${candidate.value.name ?? ''}`
		return used.has(key) ? null : candidate
	}

	const testid = collapse(facts.testid)
	if (testid) {
		return push({ kind: 'testid', value: testid, score: 0, source: 'ai' })
	}

	const id = collapse(facts.id)
	if (id && isStableId(id)) {
		return push({ kind: 'css', value: `#${escapeCssIdent(id)}`, score: 0, source: 'ai' })
	}

	const role = collapse(facts.role)
	const name = collapse(facts.accessibleName)
	if (role && name) {
		return push({
			kind: 'role',
			value: { role, name, exact: false },
			score: 0,
			source: 'ai',
		})
	}

	const nameAttr = collapse(facts.nameAttr)
	if (nameAttr && facts.tag) {
		return push({
			kind: 'css',
			value: `${facts.tag.toLowerCase()}[name="${nameAttr.replace(/"/g, '\\"')}"]`,
			score: 0,
			source: 'ai',
		})
	}

	const ariaLabel = collapse(facts.ariaLabel)
	if (ariaLabel) {
		return push({
			kind: 'css',
			value: `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`,
			score: 0,
			source: 'ai',
		})
	}

	const placeholder = collapse(facts.placeholder)
	if (placeholder) {
		return push({
			kind: 'css',
			value: `[placeholder="${placeholder.replace(/"/g, '\\"')}"]`,
			score: 0,
			source: 'ai',
		})
	}

	const text = collapse(facts.text)
	if (text && text.length <= 60) {
		return push({ kind: 'text', value: text, score: 0, source: 'ai' })
	}

	return null
}

function candidateValueKey(candidate: Candidate): string {
	return typeof candidate.value === 'string'
		? candidate.value
		: `${candidate.value.role}:${candidate.value.name ?? ''}`
}

/** 把候选渲染成日志用字符串（SelfHeal.from/to 存这个） */
export function describeCandidateForLog(candidate: Candidate): string {
	return typeof candidate.value === 'string'
		? `${candidate.kind}(${candidate.value})`
		: `role(${candidate.value.role}${candidate.value.name ? `, name=${candidate.value.name}` : ''})`
}

export interface HealInput extends SelfHealRecord {
	/** 现场推出的新候选；缺失表示只记录不写回 */
	candidate?: Candidate
}

/**
 * 把自愈结果合并进 flow：version+1、selfHealed 追加、目标 step 的 candidates 末尾追加新候选。
 * 纯函数：返回新 flow，不落盘。
 */
export function applySelfHeals(
	flow: import('@rr/schema').Flow,
	heals: HealInput[],
): import('@rr/schema').Flow {
	const usable = heals.filter((h) => h.candidate !== undefined)
	const nextSteps: Step[] = mapSteps(flow.steps, (step, stepId) => {
		const heal = usable.find((h) => h.stepId === stepId)
		if (!heal?.candidate) return step
		if (!('target' in step) || !step.target) return step
		const target = step.target
		const maxScore = target.candidates.reduce((acc, candidate) => Math.max(acc, candidate.score), 0)
		if (
			target.candidates.some((c) => candidateValueKey(c) === candidateValueKey(heal.candidate!))
		) {
			return step
		}
		const appended: Candidate = { ...heal.candidate, score: maxScore + 1 }
		return {
			...step,
			target: { ...target, candidates: [...target.candidates, appended] },
		} as Step
	})

	const selfHealed = [
		...flow.selfHealed,
		...heals.map(({ candidate: _candidate, ...rest }) => rest),
	]

	// 只有真的往 candidates 里追加了东西才升版本；纯记录不制造版本噪音
	return {
		...flow,
		version: usable.length > 0 ? flow.version + 1 : flow.version,
		steps: nextSteps,
		selfHealed,
	}
}

/** 统计字段更新（写回时一起做，让 UI 能看到通过率趋势） */
export function bumpStats(
	flow: import('@rr/schema').Flow,
	ok: boolean,
	at: string = new Date().toISOString(),
): import('@rr/schema').Flow {
	const stats = flow.stats ?? { runs: 0, passes: 0 }
	return {
		...flow,
		stats: {
			runs: stats.runs + 1,
			passes: stats.passes + (ok ? 1 : 0),
			lastRunAt: at,
		},
	}
}
