/**
 * 事件合流：把页面回传的原始事件流压成「可回放的动作」。
 *
 * 合流窗口 `bufferMs`（默认 500ms）对应浏览器自己的判定阈值：
 * - 双击：两次 click 间隔 < 500ms 且同一元素 → `clickCount: 2`（第 3 次 → 3，schema 上限 3）
 * - 输入：同一元素的连续 input 合并成一次 `input`，只留最终值（回放用 fill，语义等价）
 * - 滚动：同目标的连续 scroll 累加 delta；抖动小于阈值直接丢弃
 * - 导航：并入**前一个动作**的 expect（`expectUrl`），没有前一个动作时才单独成 `navigate`
 *
 * 纯函数：不碰 DOM / 不碰浏览器，输入输出都是普通对象，方便单测。
 */
import type { CoalescedAction, RawEvent } from './types.js'

export interface CoalesceOptions {
	/** 合流窗口，默认 500ms */
	bufferMs?: number
}

const DEFAULT_BUFFER_MS = 500
/** 输入合流窗口：比 bufferMs 宽，避免慢速人工输入被拆成多个 input 步骤 */
const INPUT_MERGE_MS = 2000
/** 滚动抖动阈值（px）：累加后小于它就当没滚 */
const SCROLL_EPSILON = 4
/** 「滚动后紧接点击」判定窗口：Playwright 点击前会 scrollIntoView，这类滚动是噪声 */
const SCROLL_INTO_VIEW_MS = 700

const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift', 'CapsLock', 'AltGraph'])

export function coalesceEvents(events: RawEvent[], opts: CoalesceOptions = {}): CoalescedAction[] {
	const bufferMs = opts.bufferMs ?? DEFAULT_BUFFER_MS
	const sorted = [...events].sort((a, b) => a.ts - b.ts)
	const actions: CoalescedAction[] = []

	for (let i = 0; i < sorted.length; i++) {
		const event = sorted[i]!
		switch (event.kind) {
			case 'pointerdown':
				// 只作为事实来源（拖拽/右键判断），本身不成步
				break

			case 'click':
			case 'contextmenu': {
				const action = clickAction(event)
				if (!action) break
				const prev = lastAction(actions)
				if (
					prev &&
					prev.kind === 'click' &&
					prev.button === action.button &&
					sameTarget(prev, action) &&
					action.ts - prev.ts <= bufferMs &&
					(prev.clickCount ?? 1) < 3
				) {
					prev.clickCount = (prev.clickCount ?? 1) + 1
					prev.ts = action.ts
					prev.merged = (prev.merged ?? 1) + 1
					prev.raw.push(...action.raw)
					// 双击以最后一次点击的坐标为准（closed shadow 兜底坐标必须精确）
					if (action.offset) prev.offset = action.offset
					break
				}
				actions.push(action)
				break
			}

			case 'input': {
				if (event.data?.checked !== undefined) break // checkbox/radio 由 click 覆盖
				// <select> 的 input 事件与 change 同时触发，统一由 change 生成 select 步骤
				if (event.facts?.tag === 'select') break
				const editable = isEditableTarget(event)
				if (!editable) break
				const prev = lastAction(actions)
				if (prev && prev.kind === 'input' && sameTarget(prev, { facts: event.facts }) && event.ts - prev.ts <= INPUT_MERGE_MS) {
					prev.value = event.data?.value
					prev.masked = event.data?.masked
					prev.ts = event.ts
					prev.merged = (prev.merged ?? 1) + 1
					prev.raw.push(event)
					break
				}
				actions.push(inputAction(event))
				break
			}

			case 'change': {
				const data = event.data ?? {}
				// 文件选择：浏览器不暴露真实路径，录制阶段无法还原（已知限制）
				if (data.inputType === 'file') break
				if (data.checked !== undefined) break // checkbox/radio 由 click 覆盖
				if (isSelectEvent(event)) {
					const prev = lastAction(actions)
					if (prev && prev.kind === 'select' && sameTarget(prev, { facts: event.facts })) {
						prev.value = data.value
						prev.selectedValues = data.selectedValues
						prev.ts = event.ts
						prev.merged = (prev.merged ?? 1) + 1
						prev.raw.push(event)
						break
					}
					actions.push(selectAction(event))
					break
				}
				// 文本控件的 change 一律丢弃：真实输入一定先有 input 事件；
				// 剩下的 change 基本是「焦点移走时浏览器补发」（blur），回放成 input 会多出一步空操作。
				break
			}

			case 'keydown': {
				const data = event.data ?? {}
				const key = data.key
				if (!key) break
				if (MODIFIER_KEYS.has(key)) break
				if (data.isPrintable) {
					// 可打印字符：后面通常会跟一个 input 事件，那条才是用户意图（值变化）
					if (isEditableTarget(event) && hasFollowingInput(sorted, i, INPUT_MERGE_MS, event)) break
					// 落在不可编辑区域的可打印按键，没有值语义，也没法回放成有意义的动作
					break
				}
				actions.push({
					kind: 'key',
					ts: event.ts,
					facts: event.facts,
					frameIndex: event.frameIndex,
					frameUrl: event.frameUrl,
					key,
					merged: 1,
					raw: [event],
				})
				break
			}

			case 'scroll': {
				const dx = event.data?.dx ?? 0
				const dy = event.data?.dy ?? 0
				const prev = lastAction(actions)
				if (
					prev &&
					prev.kind === 'scroll' &&
					sameTarget(prev, { facts: event.facts }) &&
					event.ts - prev.ts <= bufferMs
				) {
					const merged = prev.delta ?? { x: 0, y: 0 }
					prev.delta = { x: merged.x + dx, y: merged.y + dy }
					prev.ts = event.ts
					prev.merged = (prev.merged ?? 1) + 1
					prev.raw.push(event)
					break
				}
				actions.push({
					kind: 'scroll',
					ts: event.ts,
					facts: event.facts,
					frameIndex: event.frameIndex,
					frameUrl: event.frameUrl,
					delta: { x: dx, y: dy },
					merged: 1,
					raw: [event],
				})
				break
			}

			case 'navigation': {
				const url = event.url ?? event.frameUrl
				if (!url) break
				const prev = lastAction(actions)
				// 导航并入前一步 expect：录制里「点提交 → 页面跳转」是一个动作 + 一个期望
				if (prev && !prev.expectUrl && event.ts - prev.ts <= bufferMs) {
					prev.expectUrl = url
					prev.raw.push(event)
					break
				}
				actions.push({
					kind: 'navigate',
					ts: event.ts,
					frameIndex: event.frameIndex,
					frameUrl: event.frameUrl,
					url,
					merged: 1,
					raw: [event],
				})
				break
			}
		}
	}

	return postFilter(actions)
}

/* ------------------------------------------------------------------ */
/* 构造器                                                              */
/* ------------------------------------------------------------------ */

function clickAction(event: RawEvent): CoalescedAction | null {
	if (!event.facts) return null
	const button = buttonName(event.data?.button)
	return {
		kind: 'click',
		ts: event.ts,
		facts: event.facts,
		frameIndex: event.frameIndex,
		frameUrl: event.frameUrl,
		button,
		clickCount: 1,
		modifiers: normalizeModifiers(event.data?.modifiers),
		offset: event.data?.offset,
		merged: 1,
		raw: [event],
	}
}

function inputAction(event: RawEvent): CoalescedAction {
	return {
		kind: 'input',
		ts: event.ts,
		facts: event.facts,
		frameIndex: event.frameIndex,
		frameUrl: event.frameUrl,
		value: event.data?.value,
		masked: event.data?.masked,
		merged: 1,
		raw: [event],
	}
}

function selectAction(event: RawEvent): CoalescedAction {
	return {
		kind: 'select',
		ts: event.ts,
		facts: event.facts,
		frameIndex: event.frameIndex,
		frameUrl: event.frameUrl,
		value: event.data?.value,
		selectedValues: event.data?.selectedValues,
		merged: 1,
		raw: [event],
	}
}

/* ------------------------------------------------------------------ */
/* 谓词与工具                                                          */
/* ------------------------------------------------------------------ */

function lastAction(actions: CoalescedAction[]): CoalescedAction | undefined {
	return actions[actions.length - 1]
}

/**
 * 判断两个动作是否指向同一个目标。
 * - 两边都没有 facts → 都是「window 滚动」，视为同一目标；
 * - 有 uid 就比 uid；没有 uid（例如某些合成事件）退化成 tag + nodePath。
 */
function sameTarget(
	a: { facts?: { uid?: string; tag?: string; nodePath?: number[] } },
	b: { facts?: { uid?: string; tag?: string; nodePath?: number[] } },
): boolean {
	const left = a.facts
	const right = b.facts
	if (!left && !right) return true
	if (!left || !right) return false
	if (left.uid && right.uid) return left.uid === right.uid
	const leftPath = left.nodePath?.join('.')
	const rightPath = right.nodePath?.join('.')
	return !!leftPath && leftPath === rightPath && left.tag === right.tag
}

function isSelectEvent(event: RawEvent): boolean {
	return event.facts?.tag === 'select'
}

/** 值语义目标：能承载 input/change 并可用 fill() 回放 */
function isEditableTarget(event: RawEvent): boolean {
	const facts = event.facts
	if (!facts) return false
	if (facts.tag === 'input' || facts.tag === 'textarea' || facts.tag === 'select') return true
	const editable = facts.attributes['contenteditable']
	return editable === '' || editable === 'true' || editable === 'plaintext-only'
}

/** 可打印 keydown 后面是否跟着同一元素的 input（跟随则丢弃 keydown） */
function hasFollowingInput(events: RawEvent[], index: number, windowMs: number, keydown: RawEvent): boolean {
	const uid = keydown.facts?.uid
	for (let i = index + 1; i < events.length; i++) {
		const next = events[i]!
		if (next.ts - keydown.ts > windowMs) return false
		if (next.kind === 'input' && (!uid || next.facts?.uid === uid)) return true
	}
	return false
}

function buttonName(button: number | undefined): 'left' | 'right' | 'middle' {
	if (button === 1) return 'middle'
	if (button === 2) return 'right'
	return 'left'
}

function normalizeModifiers(mods: string[] | undefined): Array<'Alt' | 'Control' | 'Meta' | 'Shift'> {
	const out: Array<'Alt' | 'Control' | 'Meta' | 'Shift'> = []
	for (const mod of mods ?? []) {
		if (mod === 'Alt' || mod === 'Control' || mod === 'Meta' || mod === 'Shift') out.push(mod)
	}
	return out
}

/* ------------------------------------------------------------------ */
/* 后置过滤                                                            */
/* ------------------------------------------------------------------ */

function postFilter(actions: CoalescedAction[]): CoalescedAction[] {
	const kept: CoalescedAction[] = []
	for (let i = 0; i < actions.length; i++) {
		const action = actions[i]!
		if (action.kind === 'scroll') {
			const delta = action.delta ?? { x: 0, y: 0 }
			// 1) 抖动：几乎没滚
			if (Math.abs(delta.x) + Math.abs(delta.y) < SCROLL_EPSILON) continue
			// 2) scroll-into-view 噪声：点击/悬停前的自动滚动不是用户意图
			const next = actions[i + 1]
			if (
				next &&
				(next.kind === 'click' || next.kind === 'hover') &&
				next.ts - action.ts <= SCROLL_INTO_VIEW_MS
			)
				continue
		}
		kept.push(action)
	}
	return kept
}

/** 供 record() 复用：把一个动作里参与合并的事件全 flatten 出来（keepRaw 用） */
export function actionRawEvents(actions: CoalescedAction[]): RawEvent[] {
	return actions.flatMap((a) => a.raw)
}

/** 供测试/调试：读一个动作的合流摘要 */
export function summarizeAction(action: CoalescedAction): string {
	switch (action.kind) {
		case 'click':
			return `click ${action.button ?? 'left'}x${action.clickCount ?? 1}`
		case 'input':
			return `input ${action.masked ? '<masked>' : JSON.stringify(action.value ?? '')}`
		case 'select':
			return `select ${JSON.stringify(action.value ?? action.selectedValues ?? '')}`
		case 'key':
			return `key ${action.key}`
		case 'scroll':
			return `scroll (${action.delta?.x ?? 0},${action.delta?.y ?? 0})`
		case 'navigate':
			return `navigate ${action.url}`
		default:
			return action.kind
	}
}
