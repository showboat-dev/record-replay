/**
 * @rr/recorder —— 录制包的唯一出口。
 *
 * 对外契约（docs/architecture.md §3）：
 *   record(opts)                录制 → Flow + artifact
 *   coalesceEvents(events)      纯函数：500ms 缓冲合流（双击/输入/滚动/hover/组合键/导航）
 *   inferExpect(before, after)  纯函数：页面签名对比 → Expect
 *   buildElementRef(facts)      纯函数：页面事实 → ElementRef
 *
 * 规划层纯函数（`plan.ts`）：标签页切换合成 / 对话框插入 / hover 意义过滤 / 下载与上传。
 * 这些也导出给 CLI、executor 与单测复用。
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
export {
	downloadFilenamePattern,
	findDownloadFor,
	hasHoverSemantics,
	insertDialogs,
	isMeaningfulHover,
	mayBeMeaningfulHover,
	pageIndexOf,
	uploadVariableName,
	withTabSwitches,
	HOVER_CORRELATION_MS,
	HOVER_WAIT_MS,
} from './plan.js'
export type { TabSwitchState } from './plan.js'
export { CAPTURE_SCRIPT_PATH, EMIT_BINDING, UID_ATTR, ensureCaptureInPage } from './capture-client.js'
export type {
	RecordOptions,
	RecordResult,
	RawEvent,
	CoalescedAction,
	PageSignature,
	SignatureNode,
	RawElementFacts,
	RecordedDialog,
	RecordedDownload,
	PlannedItem,
} from './types.js'
