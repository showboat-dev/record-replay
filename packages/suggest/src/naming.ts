/**
 * 变量命名与类型推断（docs/parameterization.md §4）。
 *
 * - 中文 label/placeholder/name 命中词表 → 固定 ASCII 名（长词优先，如「订单号」→ order_no）；
 * - 英文 label → snake_case（非法字符剔除）；
 * - 都没有/不可映射 → `field_<stepIndex+1>`；
 * - 查重与 `flow.variables` + 本批已分配名字一起做，重复则 `_2`、`_3`…（按步骤顺序确定）；
 * - 类型由 inputType / 字段词推断：email|tel→email、date→date、number|金额|数量→number、
 *   泛文本→text、其余 string。
 */
import { hasCjk, isValidVariableName, NAME_GLOSSARY, textHasAny, toSnakeCase } from './internal.js'
import type { SuggestVariableType } from './types.js'

export interface NameInput {
	label?: string
	placeholder?: string
	nameAttr?: string
	stepIndex: number
	inputType?: string
}

/** 中文词表按长度倒序，保证「订单号」优先于「单号」、「用户名」优先于「姓名」的包含关系 */
const GLOSSARY_SORTED = [...NAME_GLOSSARY].sort((a, b) => b[0].length - a[0].length)

const AMOUNT_WORDS_ZH = ['金额', '价格', '数量', '件数', '个数']
const AMOUNT_WORDS_EN = ['amount', 'price', 'quantity', 'qty']
const DATE_WORDS_ZH = ['日期']
const DATE_WORDS_EN = ['date']
const EMAIL_WORDS_ZH = ['邮箱', '邮件']
const EMAIL_WORDS_EN = ['email']
const GENERIC_TEXT_ZH = ['简介', '备注', '说明']
const GENERIC_TEXT_EN = ['remark', 'note', 'comment']

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim()
	}
	return undefined
}

/** 根据字段语义给出候选变量名（不含查重） */
export function deriveVariableName(input: NameInput): string {
	const fallback = `field_${input.stepIndex + 1}`
	const source = firstNonEmpty(input.label, input.placeholder, input.nameAttr)
	if (!source) return fallback

	if (hasCjk(source)) {
		for (const [zh, ascii] of GLOSSARY_SORTED) {
			if (source.includes(zh)) return ascii
		}
		return fallback
	}

	const snake = toSnakeCase(source)
	if (snake && isValidVariableName(snake)) return snake
	return fallback
}

/** 在 existing + 本批已分配名字中查重，返回唯一名字（重复则 base_2、base_3…） */
export function makeUniqueName(base: string, taken: ReadonlySet<string>): string {
	const safe = isValidVariableName(base) ? base : 'field'
	if (!taken.has(safe)) return safe
	let suffix = 2
	while (taken.has(`${safe}_${suffix}`)) suffix += 1
	return `${safe}_${suffix}`
}

/** 由 inputType / 字段词推断变量类型（§4；变量类型枚举里没有 tel，故 tel → email） */
export function deriveVariableType(input: NameInput): SuggestVariableType {
	const inputType = (input.inputType ?? '').trim().toLowerCase()
	if (inputType === 'email') return 'email'
	// 见 docs/parameterization.md §4：`email`/`tel` → `email`（Variable.type 没有 tel/phone）
	if (inputType === 'tel') return 'email'
	if (inputType === 'date') return 'date'
	if (inputType === 'number') return 'number'

	const text = [input.label, input.placeholder, input.nameAttr]
		.filter((value): value is string => typeof value === 'string' && value.length > 0)
		.join(' ')

	if (textHasAny(text, AMOUNT_WORDS_ZH, AMOUNT_WORDS_EN)) return 'number'
	if (textHasAny(text, DATE_WORDS_ZH, DATE_WORDS_EN)) return 'date'
	if (textHasAny(text, EMAIL_WORDS_ZH, EMAIL_WORDS_EN)) return 'email'
	if (textHasAny(text, GENERIC_TEXT_ZH, GENERIC_TEXT_EN)) return 'text'
	if (inputType === 'textarea') return 'text'
	return 'string'
}
