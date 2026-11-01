/**
 * 规划层：合流之后、成步之前的几个**纯函数**决策。
 *
 * 为什么单独一层：这三件事都「不能只看一条事件」——
 * 1. 标签页切换：要知道上一步在哪个 tab（跨批次状态），且要在动作**之前**插一条合成 `switchTab`；
 * 2. 对话框：是旁路事件（`page.on('dialog')`），必须按时间插到「触发它的那一步」**之后**；
 * 3. hover 是否有意义：要看「后面 2s 内有没有点别的元素」。
 *
 * 全纯函数 → 可以脱离浏览器单测（见 `plan.test.ts`）。
 */
import type { CoalescedAction, PlannedItem, RecordedDialog, RecordedDownload } from './types.js'

/** hover 相关性窗口：悬停后 2s 内点了另一个元素，才算「悬停展开菜单再点」 */
export const HOVER_CORRELATION_MS = 2000
/** hover 最多能等多久的「后续 click」（超时就判定为无意义噪声并丢弃） */
export const HOVER_WAIT_MS = 2500

/* ------------------------------------------------------------------ */
/* 1. 标签页切换                                                        */
/* ------------------------------------------------------------------ */

export interface TabSwitchState {
	/** 当前所在的标签页序号（调用方持有一份，跨批次复用） */
	page: number
}

/** 动作归属到哪个标签页（缺省视为当前页） */
export function pageIndexOf(action: CoalescedAction, fallback: number): number {
	return action.pageIndex ?? fallback
}

/**
 * 动作的 pageIndex 发生变化时，在它前面插一条合成 `switchTab`。
 *
 * 为什么需要合成：用户点浏览器标签栏的动作发生在浏览器 chrome 上，
 * 页面 JS 完全捕获不到；我们只能从「下一个页面事件来自另一个 tab」反推出「用户切过页」。
 *
 * @param state 会被就地更新（`state.page` 变成最后一个动作所在的页），跨批次调用要复用同一个对象
 */
export function withTabSwitches(actions: CoalescedAction[], state: TabSwitchState): PlannedItem[] {
	const items: PlannedItem[] = []
	for (const action of actions) {
		const page = pageIndexOf(action, state.page)
		if (page !== state.page) {
			items.push({ kind: 'switchTab', ts: action.ts, index: page, pageIndex: page })
			state.page = page
		}
		items.push({ kind: 'action', action })
	}
	return items
}

/* ------------------------------------------------------------------ */
/* 2. 对话框插入                                                        */
/* ------------------------------------------------------------------ */

function itemTs(item: PlannedItem): number {
	return item.kind === 'action' ? item.action.ts : item.ts
}

/**
 * 把对话框插到「触发它的那一步」之后。
 *
 * 判定方式：dialog 时间戳落在哪一步的时间之后，就紧跟在它后面。
 * （原生 dialog 是在触发它的 click handler 里同步弹出的，所以 dialog.ts ≈ click.ts 或稍晚，
 * 用 `<=` 比较会把它放到 click 之前 —— 因此这里用「最后一个 ts <= dialog.ts 的条目之后」。）
 *
 * @returns `items` 新数组 + 本次消费掉的 dialogs（调用方不要把同一批再插一次）
 */
export function insertDialogs(
	items: PlannedItem[],
	dialogs: RecordedDialog[],
): { items: PlannedItem[]; consumed: RecordedDialog[] } {
	if (!dialogs.length) return { items, consumed: [] }
	const sorted = [...dialogs].sort((a, b) => a.ts - b.ts)
	const out: PlannedItem[] = []
	const consumed: RecordedDialog[] = []
	let index = 0
	for (const item of items) {
		// 插在「第一个时间晚于 dialog 的条目」之前 —— 也就是紧跟触发它的那一步
		const ts = itemTs(item)
		while (index < sorted.length && sorted[index]!.ts < ts) {
			const dialog = sorted[index++]!
			out.push(dialogItem(dialog))
			consumed.push(dialog)
		}
		out.push(item)
	}
	// 剩下的（发生在所有动作之后）挂在末尾
	while (index < sorted.length) {
		const dialog = sorted[index++]!
		out.push(dialogItem(dialog))
		consumed.push(dialog)
	}
	return { items: out, consumed }
}

function dialogItem(dialog: RecordedDialog): PlannedItem {
	return {
		kind: 'dialog',
		ts: dialog.ts,
		pageIndex: dialog.pageIndex,
		action: dialog.action,
		...(dialog.promptText === undefined ? {} : { promptText: dialog.promptText }),
	}
}

/* ------------------------------------------------------------------ */
/* 3. hover 意义过滤                                                    */
/* ------------------------------------------------------------------ */

/** 目标自带「我可能是菜单触发器」的语义（aria-haspopup / aria-expanded） */
export function hasHoverSemantics(hover: CoalescedAction): boolean {
	const attrs = hover.facts?.attributes ?? {}
	return 'aria-haspopup' in attrs || 'aria-expanded' in attrs
}

/**
 * hover 是否值得记成一步。
 *
 * 只保留两类：
 * - 目标有 `aria-haspopup` / `aria-expanded`（明显是菜单触发器，回放时必须先悬停）；
 * - 其后 2s 内对**另一个**元素发生了 click（「悬停展开菜单 → 点菜单项」的业务动作）。
 *
 * 其余全部丢弃：鼠标划过页面的 hover 是海量噪声，录进 flow 只会拖慢回放、增加 flaky。
 */
export function isMeaningfulHover(hover: CoalescedAction, following: CoalescedAction[]): boolean {
	if (hasHoverSemantics(hover)) return true
	const hoverUid = hover.facts?.uid
	return following.some(
		(next) =>
			next.kind === 'click' &&
			next.ts >= hover.ts &&
			next.ts - hover.ts <= HOVER_CORRELATION_MS &&
			next.facts?.uid !== hoverUid,
	)
}

/** 后续是否还有可能「让这个 hover 变有意义」的 click（用来决定要不要先挂起） */
export function mayBeMeaningfulHover(hover: CoalescedAction, following: CoalescedAction[]): boolean {
	return isMeaningfulHover(hover, following)
}

/* ------------------------------------------------------------------ */
/* 4. 下载 / 上传                                                       */
/* ------------------------------------------------------------------ */

/**
 * 下载文件名 → 匹配 pattern。
 *
 * 保留人可读的部分、把明显的动态数字段换成 `*`（`export-20261101.csv` → `export-*.csv`），
 * 这样同一次业务操作在不同日期回放都成立。
 */
export function downloadFilenamePattern(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? filename
	const pattern = base.replace(/\d{2,}/g, '*')
	return pattern || '*'
}

/**
 * 给「触发下载的那一步」找下载记录。
 *
 * 判定必须用**动作时间窗** `[action.ts, nextTs)`，不能用「动作后 N 秒」：
 * 录制里相邻动作可能只差几百毫秒（点确认框 → 打开上传页 → 点下载），
 * 用宽窗口会把下载挂到前面无关的动作上（实测踩过）。
 */
export function findDownloadFor(
	action: CoalescedAction,
	downloads: RecordedDownload[],
	consumed: ReadonlySet<RecordedDownload>,
	nextTs: number | undefined,
): RecordedDownload | undefined {
	return downloads.find(
		(download) =>
			!consumed.has(download) &&
			download.ts >= action.ts &&
			(nextTs === undefined || download.ts < nextTs) &&
			download.pageIndex === (action.pageIndex ?? 0),
	)
}

/** 上传占位变量名：file_1 / file_2 …（给 `upload.files` 用） */
export function uploadVariableName(seq: number): string {
	return `file_${seq}`
}
