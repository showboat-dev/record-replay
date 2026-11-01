/**
 * @rr/suggest 内部共享工具（不通过 index.ts 导出）。
 *
 * 这里集中放 analyze / naming / apply 都要用的规则常量与小函数：
 * - 步骤 flatten / 查找 / 深拷贝；
 * - ElementRef → 可读字段信息（label / placeholder / name / id / type）；
 * - docs/parameterization.md §3/§4 的词表与值格式判定；
 * - 模板 `{{name}}` 的检测与替换。
 */
import type { ElementRef, Flow, Step } from '@rr/schema'

/* ------------------------------------------------------------------ */
/* 步骤遍历                                                            */
/* ------------------------------------------------------------------ */

export interface FlatStep {
	step: Step
	/** flatten（深度优先）后的下标，从 0 开始，与 UI「第 N 步」一致 */
	index: number
}

/** 深度优先展开 group，返回 [{ step, index }]（group 自身也会占一个下标） */
export function flattenSteps(steps: Step[], out: FlatStep[] = []): FlatStep[] {
	for (const step of steps) {
		out.push({ step, index: out.length })
		if (step.kind === 'group') flattenSteps(step.steps, out)
	}
	return out
}

/** 按 id 查找步骤（支持 group 内嵌套），返回步骤引用与扁平下标 */
export function findFlatStep(flow: Flow, stepId: string): FlatStep | undefined {
	return flattenSteps(flow.steps).find((item) => item.step.id === stepId)
}

/** 纯函数：深拷贝 flow（建议/应用都不改入参） */
export function cloneFlow(flow: Flow): Flow {
	return structuredClone(flow)
}

/* ------------------------------------------------------------------ */
/* ElementRef 字段信息                                                 */
/* ------------------------------------------------------------------ */

/** 合并 observed.attributes 与 fingerprint.attrs（observed 优先，录制事实为准） */
export function mergedAttrs(target: ElementRef): Record<string, string> {
	return { ...target.fingerprint.attrs, ...target.observed.attributes }
}

/** aria label / 文本候选里最像标签的那个 */
function candidateLabel(target: ElementRef): string | undefined {
	for (const candidate of target.candidates) {
		if (candidate.kind !== 'label' && candidate.kind !== 'text') continue
		if (typeof candidate.value === 'string' && candidate.value.trim()) return candidate.value.trim()
	}
	return undefined
}

/**
 * 元素的「label」：候选 label/text → aria-label → accessibleName → placeholder → name → id。
 * 见 types.ts SuggestionTargetInfo.label 的注释（优先级最高者可读名）。
 */
export function resolveLabel(target: ElementRef): string | undefined {
	const attrs = mergedAttrs(target)
	const candidates = [
		candidateLabel(target),
		attrs['aria-label'],
		target.fingerprint.accessibleName,
		attrs['placeholder'],
		attrs['name'],
		attrs['id'],
	]
	for (const item of candidates) {
		if (typeof item === 'string' && item.trim()) return item.trim()
	}
	return undefined
}

export function attr(target: ElementRef, name: string): string | undefined {
	const value = mergedAttrs(target)[name]
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** input 的 type（textarea 返回 'textarea'，便于类型推断/负向规则使用） */
export function inputTypeOf(target: ElementRef): string | undefined {
	const type = attr(target, 'type')
	if (type) return type.toLowerCase()
	if (target.observed.tag.toLowerCase() === 'textarea') return 'textarea'
	return undefined
}

/** 用于「字段词表」匹配的文本：标签/占位/name/id/aria-label/可选名，去重去空 */
export function fieldTexts(target: ElementRef): string[] {
	const attrs = mergedAttrs(target)
	const values = [
		candidateLabel(target),
		attrs['aria-label'],
		target.fingerprint.accessibleName,
		attrs['placeholder'],
		attrs['name'],
		attrs['id'],
		// data-testid 也是稳定的「id 类」语义属性（录制器常用 field-email / full-name 这类命名）
		attrs['data-testid'],
		attrs['data-test'],
	]
	for (const candidate of target.candidates) {
		if (candidate.kind === 'testid' && typeof candidate.value === 'string')
			values.push(candidate.value)
	}
	const out: string[] = []
	for (const value of values) {
		if (typeof value === 'string' && value.trim() && !out.includes(value.trim()))
			out.push(value.trim())
	}
	return out
}

/** 密码/密钥类目标：值已脱敏，绝不进入参数化建议 */
export function isSecretTarget(target: ElementRef): boolean {
	const attrs = mergedAttrs(target)
	const type = (attrs['type'] ?? '').toLowerCase()
	if (type === 'password') return true

	const autocomplete = (attrs['autocomplete'] ?? '').toLowerCase()
	if (autocomplete.includes('password')) return true

	const hint = [
		attrs['name'],
		attrs['id'],
		attrs['aria-label'],
		attrs['placeholder'],
		resolveLabel(target),
	]
		.filter((value): value is string => typeof value === 'string' && value.length > 0)
		.join(' ')
		.toLowerCase()
	return /password|passwd|pwd|secret|密码|口令/.test(hint)
}

/** 文本域 + 泛化文本词（备注/说明/简介…），参数化收益低 */
export function isGenericTextTarget(target: ElementRef): boolean {
	if (target.observed.tag.toLowerCase() !== 'textarea') return false
	const texts = fieldTexts(target).join(' ').toLowerCase()
	return textHasAny(texts, GENERIC_TEXT_WORDS_ZH, GENERIC_TEXT_WORDS_EN)
}

/** 可参数化的字段：input / select，且值必须是字符串（数组 = 多选下拉，不支持） */
export interface FieldInfo {
	kind: 'input' | 'select'
	value: string | string[]
	target: ElementRef
}

export function fieldOf(step: Step): FieldInfo | undefined {
	if (step.kind === 'input') return { kind: 'input', value: step.value, target: step.target }
	if (step.kind === 'select') return { kind: 'select', value: step.value, target: step.target }
	return undefined
}

/* ------------------------------------------------------------------ */
/* 词表（docs/parameterization.md §2/§3/§4）                            */
/* ------------------------------------------------------------------ */

/** §3 业务字段词（用于 +3 打分），按「长词优先」匹配理由更好读 */
export const BUSINESS_WORDS_ZH = [
	'用户名',
	'身份证',
	'姓名',
	'名称',
	'客户',
	'公司',
	'地址',
	'邮箱',
	'邮件',
	'电话',
	'手机',
	'金额',
	'价格',
	'数量',
	'单号',
	'订单',
	'编号',
	'账号',
	'日期',
	'时间',
	'城市',
	'国家',
]

export const BUSINESS_WORDS_EN = [
	'name',
	'email',
	'phone',
	'address',
	'amount',
	'price',
	'quantity',
	'qty',
	'order',
	'no',
	'id',
	'account',
	'date',
	'city',
	'country',
	'company',
]

/** §4 中文词表 → ASCII 变量名 */
export const NAME_GLOSSARY: ReadonlyArray<readonly [string, string]> = [
	['用户名', 'username'],
	['订单号', 'order_no'],
	['身份证', 'id_number'],
	['姓名', 'name'],
	['邮箱', 'email'],
	['邮件', 'email'],
	['手机', 'phone'],
	['电话', 'phone'],
	['地址', 'address'],
	['金额', 'amount'],
	['价格', 'amount'],
	['数量', 'quantity'],
	['单号', 'order_no'],
	['编号', 'code'],
	['日期', 'date'],
	['账号', 'account'],
	['公司', 'company'],
	['客户', 'customer'],
	['城市', 'city'],
	['国家', 'country'],
	['备注', 'remark'],
	['简介', 'bio'],
]

/** §3 负向：搜索/筛选类 */
export const SEARCH_WORDS_ZH = ['搜索', '查找', '筛选']
export const SEARCH_WORDS_EN = ['search', 'filter', 'query']

/** §3 负向 + §4 泛文本 */
export const GENERIC_TEXT_WORDS_ZH = ['简介', '备注', '说明']
export const GENERIC_TEXT_WORDS_EN = ['remark', 'note', 'comment']

/** 数量词（+1 信号） */
export const QUANTITY_WORDS_ZH = ['数量', '件数', '个数']
export const QUANTITY_WORDS_EN = ['quantity', 'qty']

const CJK_RE = /[\u3400-\u9fff]/

export function hasCjk(text: string): boolean {
	return CJK_RE.test(text)
}

/** 文本是否包含任一中文词或英文单词（英文用词边界，避免 update 命中 date） */
export function textHasAny(
	text: string,
	zhWords: readonly string[],
	enWords: readonly string[] = [],
): boolean {
	if (!text) return false
	for (const word of zhWords) {
		if (text.includes(word)) return true
	}
	const lower = text.toLowerCase()
	for (const word of enWords) {
		if (new RegExp(`\\b${escapeRegExp(word)}\\b`).test(lower)) return true
	}
	return false
}

/** 返回命中的第一个业务词（中文长词优先），用于 reasons 展示 */
export function firstBusinessWord(texts: readonly string[]): string | undefined {
	const sortedZh = [...BUSINESS_WORDS_ZH].sort((a, b) => b.length - a.length)
	for (const text of texts) {
		for (const word of sortedZh) {
			if (text.includes(word)) return word
		}
	}
	const lower = texts.join(' ').toLowerCase()
	for (const word of BUSINESS_WORDS_EN) {
		if (new RegExp(`\\b${escapeRegExp(word)}\\b`).test(lower)) return word
	}
	return undefined
}

/* ------------------------------------------------------------------ */
/* 值格式判定（§3 值格式 +2）                                          */
/* ------------------------------------------------------------------ */

export type ValueFormat = 'email' | 'phone' | 'date' | 'amount' | 'id-like'

export const VALUE_FORMAT_LABEL: Record<ValueFormat, string> = {
	email: '邮箱',
	phone: '手机号',
	date: '日期',
	amount: '金额',
	'id-like': '长编号',
}

const EMAIL_VALUE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_VALUE_RE = /^(?:\+?86[-\s]?)?1[3-9]\d{9}$/
const DATE_VALUE_RE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)$/
const AMOUNT_CURRENCY_RE = /^[¥￥$€]\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/
const AMOUNT_THOUSANDS_RE = /^-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/
const ID_LIKE_RE = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9_-]{7,}$/

/** 值格式分类（按 email → phone → date → amount → id-like 优先级，最多命中一个） */
export function classifyValue(value: string): ValueFormat | undefined {
	const trimmed = value.trim()
	if (!trimmed) return undefined
	if (EMAIL_VALUE_RE.test(trimmed)) return 'email'
	if (PHONE_VALUE_RE.test(trimmed)) return 'phone'
	if (DATE_VALUE_RE.test(trimmed)) return 'date'
	if (AMOUNT_CURRENCY_RE.test(trimmed) || AMOUNT_THOUSANDS_RE.test(trimmed)) return 'amount'
	if (ID_LIKE_RE.test(trimmed)) return 'id-like'
	return undefined
}

/** 1–3 位纯数字（数量词 +1 用） */
export function isShortNumber(value: string): boolean {
	return /^\d{1,3}$/.test(value.trim())
}

/* ------------------------------------------------------------------ */
/* 模板 {{name}}                                                       */
/* ------------------------------------------------------------------ */

/** 值里是否已含模板标记（`{{` 或 `}}`） */
export function containsTemplate(value: string): boolean {
	return value.includes('{{') || value.includes('}}')
}

/** 替换指定变量的模板，保留其他模板；`{{ old }}` 这种带空格的写法也覆盖 */
export function replaceTemplateName(value: string, from: string, to: string): string {
	const re = new RegExp(`\\{\\{\\s*${escapeRegExp(from)}\\s*\\}\\}`, 'g')
	return value.replace(re, `{{${to}}}`)
}

/** 仅用于测试/调试：提取值里出现的变量名（去重、保序） */
export function templateNames(value: string): string[] {
	const names: string[] = []
	const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
	for (const match of value.matchAll(re)) {
		const name = match[1]
		if (name && !names.includes(name)) names.push(name)
	}
	return names
}

/* ------------------------------------------------------------------ */
/* 其他                                                                */
/* ------------------------------------------------------------------ */

/** 校验变量名是否为合法标识符（与 schema VariableSchema.name 一致） */
export function isValidVariableName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/** ASCII 文本 → snake_case；非法字符剔除、首尾下划线去掉 */
export function toSnakeCase(text: string): string {
	return text
		.replace(/['’]/g, '')
		.replace(/[^A-Za-z0-9]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase()
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
