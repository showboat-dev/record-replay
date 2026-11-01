/**
 * 组合键（key chord）拼接 —— 纯函数，可单测。
 *
 * Playwright 的 `press()` 语法是 `Modifier+Modifier+Key`，例如 `Control+Shift+A`。
 * IR 里把修饰键和主键分开存（`key.step.modifiers: ['Control']`, `key: 'A'`），
 * 这样录制端不用拼字符串、UI 也能分别展示/编辑。
 */

export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

/** 固定顺序：与 Playwright 文档示例一致，便于日志/快照稳定比对 */
const MODIFIER_ORDER: readonly KeyModifier[] = ['Control', 'Alt', 'Shift', 'Meta']

/**
 * 拼出 `press()` 用的 chord 字符串。
 *
 * 规则：
 * - 没有修饰键 → 原样返回主键（兼容老 flow，`key` 可能就是 `Enter` / `Control+A`）；
 * - 主键本身已经带 `+`（老 flow / 手写）→ 原样返回，不重复拼（避免 `Control+Control+A`）；
 * - 修饰键去重 + 按固定顺序排列；与主键同名的修饰键丢掉（`modifiers:['Control'], key:'Control'`）；
 * - 修饰键为空数组 → 等价于没有修饰键。
 */
export function buildKeyChord(
	key: string,
	modifiers?: ReadonlyArray<KeyModifier> | null,
): string {
	const trimmedKey = key.trim()
	if (trimmedKey === '') return ''
	if (!modifiers || modifiers.length === 0) return trimmedKey
	// 老 flow 可能已经把修饰键写进 key（例如 key='Control+A'）
	if (trimmedKey.includes('+')) return trimmedKey

	const unique = new Set(modifiers)
	const ordered = MODIFIER_ORDER.filter(
		(modifier) => unique.has(modifier) && modifier.toLowerCase() !== trimmedKey.toLowerCase(),
	)
	if (ordered.length === 0) return trimmedKey
	return [...ordered, trimmedKey].join('+')
}

/** 日志用：把 chord 展开成人读形式（`Control+A` → `Ctrl+A`） */
export function describeKeyChord(chord: string): string {
	return chord.replace(/\bControl\b/g, 'Ctrl').replace(/\bMeta\b/g, 'Cmd')
}
