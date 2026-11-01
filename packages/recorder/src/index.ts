/**
 * @rr/recorder —— 录制包的唯一出口。
 *
 * 对外契约（docs/architecture.md §3）：
 *   record(opts)                录制 → Flow + artifact
 *   coalesceEvents(events)      纯函数：500ms 缓冲合流（双击/输入/滚动/导航）
 *   inferExpect(before, after)  纯函数：页面签名对比 → Expect
 *   buildElementRef(facts)      纯函数：页面事实 → ElementRef
 *
 * 另外导出若干小工具（纯函数为主），给 CLI / executor / 单测复用。
 */
export { record } from './record.js'
export { coalesceEvents, summarizeAction, actionRawEvents } from './coalesce.js'
export type { CoalesceOptions } from './coalesce.js'
export { inferExpect, appearedNodes, pickExpectTarget, urlPattern, emptySignature } from './expect.js'
export {
	buildElementRef,
	buildObservedFacts,
	deriveCandidates,
	dedupeCandidates,
	sortCandidates,
	pickFingerprintAttrs,
	stableHashOf,
	isDynamicValue,
	describeElementFacts,
	xpathFromNodePath,
	cssIdent,
	SCORE,
} from './element.js'
export { CAPTURE_SCRIPT_PATH, EMIT_BINDING, UID_ATTR } from './capture-client.js'
export type {
	RecordOptions,
	RecordResult,
	RawEvent,
	CoalescedAction,
	PageSignature,
	SignatureNode,
	RawElementFacts,
} from './types.js'
