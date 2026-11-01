/**
 * RR IR（action trace）schema —— 唯一真源。
 *
 * 设计约定（与 docs/ 计划一致）：
 * 1. `observed` 是录制时的原始事实，回放/自愈 **不得修改**；
 * 2. `candidates` / `fingerprint` 是"解析结果"，AI 自愈可以写回（version+1）；
 * 3. 大文件（截图/DOM 快照）不进 IR，只存相对路径（crop.ref / artifact ref）；
 * 4. 敏感值永远不落明文：password 这类字段必须是 {{var}} 模板。
 */
import { z } from 'zod'

export const SCHEMA_VERSION = 1

/** 元素/视口矩形（相对 viewport 的 CSS 像素） */
export const RectSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
})
export type Rect = z.infer<typeof RectSchema>

/** 语义候选：按 score 升序，越小越可信 */
export const CandidateSchema = z.object({
	kind: z.enum(['testid', 'role', 'label', 'text', 'css', 'xpath']),
	value: z.union([
		z.string(),
		z.object({
			role: z.string(),
			name: z.string().optional(),
			exact: z.boolean().optional(),
		}),
	]),
	score: z.number(),
	source: z.enum(['record', 'ai']).default('record'),
})
export type Candidate = z.infer<typeof CandidateSchema>

export const FingerprintSchema = z.object({
	tag: z.string(),
	role: z.string().optional(),
	accessibleName: z.string().optional(),
	/** 属性白名单（id、name、type、placeholder、aria- 与 data- 前缀属性等），已剔除动态 class */
	attrs: z.record(z.string()).default({}),
	/** sha1(tag + role + name + 稳定属性) */
	stableHash: z.string(),
	/** 从 frame document 到元素的 childIndex 链（最后手段） */
	nodePath: z.array(z.number().int().min(0)).optional(),
	/** 录制时的 CDP 节点 id，仅同 session 内有效 */
	backendNodeId: z.number().int().optional(),
})
export type Fingerprint = z.infer<typeof FingerprintSchema>

/** 录制时的原始事实（不可变） */
export const ObservedFactsSchema = z.object({
	tag: z.string(),
	attributes: z.record(z.string()).default({}),
	text: z.string().optional(),
	rect: RectSchema,
	scroll: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
	viewport: z.object({ width: z.number(), height: z.number() }),
	dpr: z.number().default(1),
	recordedAt: z.number().int(),
})
export type ObservedFacts = z.infer<typeof ObservedFactsSchema>

/** iframe 链上的一层锚点（不含嵌套 frame，避免递归） */
export const FrameAnchorSchema = z.object({
	observed: ObservedFactsSchema,
	candidates: z.array(CandidateSchema).min(1),
	fingerprint: FingerprintSchema,
})
export type FrameAnchor = z.infer<typeof FrameAnchorSchema>

export const FrameSegmentSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('frameElement'), anchor: FrameAnchorSchema }),
	z.object({ kind: z.literal('urlPattern'), pattern: z.string() }),
	z.object({ kind: z.literal('index'), index: z.number().int().min(0) }),
])
export type FrameSegment = z.infer<typeof FrameSegmentSchema>

export const FramePathSchema = z.object({ path: z.array(FrameSegmentSchema).default([]) })
export type FramePath = z.infer<typeof FramePathSchema>

export const CropSchema = z.object({
	/** 相对 artifacts 目录的路径，禁止绝对路径 / .. */
	ref: z.string().min(1),
	dpr: z.number().default(1),
})
export type Crop = z.infer<typeof CropSchema>

/** 元素证据链：整个产品的核心 */
export const ElementRefSchema = z.object({
	observed: ObservedFactsSchema,
	candidates: z.array(CandidateSchema).min(1),
	fingerprint: FingerprintSchema,
	frame: FramePathSchema.default({ path: [] }),
	/** 给 AI 兜底 / 产品 UI 展示用 */
	description: z.string().optional(),
	/** 邻近文本锚点（左/上/父容器内的文本片段） */
	nearbyText: z.array(z.string()).optional(),
	crop: CropSchema.optional(),
})
export type ElementRef = z.infer<typeof ElementRefSchema>

/** 期望效果（录制时自动推断，回放时用于校验） */
export const ExpectSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('urlChange'), pattern: z.string() }),
	z.object({ kind: z.literal('elementVisible'), target: ElementRefSchema }),
	z.object({ kind: z.literal('elementHidden'), target: ElementRefSchema }),
	z.object({ kind: z.literal('textChange'), target: ElementRefSchema, to: z.string() }),
	z.object({ kind: z.literal('domSignature'), hash: z.string(), region: z.string().optional() }),
])
export type Expect = z.infer<typeof ExpectSchema>

export const VariableSchema = z.object({
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '变量名必须是合法标识符'),
	type: z.enum(['string', 'secret']).default('string'),
	defaultValue: z.string().optional(),
	/** secret 变量不会出现在 trace 明文里；UI 只显示 ****** */
	secret: z.boolean().default(false),
	source: z.enum(['input', 'csv']).default('input'),
})
export type Variable = z.infer<typeof VariableSchema>

const PointRefSchema = z.object({
	target: ElementRefSchema.optional(),
	x: z.number().optional(),
	y: z.number().optional(),
})

const BaseStepSchema = z.object({
	id: z.string().min(1),
	label: z.string().optional(),
	timeout: z.number().int().positive().optional(),
	expect: ExpectSchema.optional(),
})

const navigateStep = BaseStepSchema.extend({
	kind: z.literal('navigate'),
	url: z.string(),
})

const clickStep = BaseStepSchema.extend({
	kind: z.literal('click'),
	target: ElementRefSchema,
	button: z.enum(['left', 'right', 'middle']).default('left'),
	clickCount: z.number().int().min(1).max(3).default(1),
	modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).default([]),
})

const inputStep = BaseStepSchema.extend({
	kind: z.literal('input'),
	target: ElementRefSchema,
	value: z.string(),
	clear: z.boolean().default(true),
})

const selectStep = BaseStepSchema.extend({
	kind: z.literal('select'),
	target: ElementRefSchema,
	value: z.union([z.string(), z.array(z.string())]),
})

const keyStep = BaseStepSchema.extend({
	kind: z.literal('key'),
	key: z.string().min(1),
	target: ElementRefSchema.optional(),
})

const hoverStep = BaseStepSchema.extend({
	kind: z.literal('hover'),
	target: ElementRefSchema,
})

const scrollStep = BaseStepSchema.extend({
	kind: z.literal('scroll'),
	target: ElementRefSchema.optional(),
	delta: z.object({ x: z.number().optional(), y: z.number().optional() }).optional(),
	to: z.enum(['top', 'bottom']).optional(),
})

const dragStep = BaseStepSchema.extend({
	kind: z.literal('drag'),
	from: ElementRefSchema,
	to: PointRefSchema,
})

const uploadStep = BaseStepSchema.extend({
	kind: z.literal('upload'),
	target: ElementRefSchema,
	files: z.array(z.string()).min(1),
})

const waitStep = BaseStepSchema.extend({
	kind: z.literal('wait'),
	condition: z.enum(['element', 'networkIdle', 'timeout']),
	target: ElementRefSchema.optional(),
	ms: z.number().int().min(0).optional(),
})

const AssertionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('visible') }),
	z.object({ kind: z.literal('hidden') }),
	z.object({
		kind: z.literal('text'),
		equals: z.string().optional(),
		contains: z.string().optional(),
	}),
	z.object({ kind: z.literal('value'), equals: z.string() }),
	z.object({ kind: z.literal('count'), equals: z.number().int().min(0) }),
])
export type Assertion = z.infer<typeof AssertionSchema>

const assertStep = BaseStepSchema.extend({
	kind: z.literal('assert'),
	target: ElementRefSchema.optional(),
	assertion: AssertionSchema,
})

const extractStep = BaseStepSchema.extend({
	kind: z.literal('extract'),
	target: ElementRefSchema,
	into: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	prop: z.enum(['text', 'value', 'attr']).default('text'),
	attr: z.string().optional(),
})

const scriptStep = BaseStepSchema.extend({
	kind: z.literal('script'),
	code: z.string().min(1),
})

export type Step =
	| z.infer<typeof navigateStep>
	| z.infer<typeof clickStep>
	| z.infer<typeof inputStep>
	| z.infer<typeof selectStep>
	| z.infer<typeof keyStep>
	| z.infer<typeof hoverStep>
	| z.infer<typeof scrollStep>
	| z.infer<typeof dragStep>
	| z.infer<typeof uploadStep>
	| z.infer<typeof waitStep>
	| z.infer<typeof assertStep>
	| z.infer<typeof extractStep>
	| z.infer<typeof scriptStep>
	| { kind: 'group'; id: string; label: string; steps: Step[]; expect?: Expect; timeout?: number }

export const StepSchema: z.ZodType<Step, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.union([
		navigateStep,
		clickStep,
		inputStep,
		selectStep,
		keyStep,
		hoverStep,
		scrollStep,
		dragStep,
		uploadStep,
		waitStep,
		assertStep,
		extractStep,
		scriptStep,
		BaseStepSchema.extend({
			kind: z.literal('group'),
			label: z.string(),
			steps: z.array(StepSchema),
		}),
	]),
)

export const EnvSchema = z.object({
	startUrl: z.string(),
	viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
	dpr: z.number().default(1),
	userAgent: z.string().optional(),
	locale: z.string().optional(),
	timezone: z.string().optional(),
})
export type Env = z.infer<typeof EnvSchema>

export const SelfHealSchema = z.object({
	stepId: z.string(),
	at: z.string(),
	level: z.enum(['L2', 'L3', 'L4']),
	from: z.string(),
	to: z.string().optional(),
	confidence: z.number().min(0).max(1).optional(),
	needsReview: z.boolean().default(false),
})
export type SelfHeal = z.infer<typeof SelfHealSchema>

export const FlowSchema = z.object({
	schemaVersion: z.literal(SCHEMA_VERSION),
	id: z.string().min(1),
	title: z.string().min(1),
	version: z.number().int().min(1).default(1),
	createdAt: z.string(),
	meta: z.object({
		env: EnvSchema,
		recorder: z.object({ name: z.string(), version: z.string() }),
	}),
	variables: z.array(VariableSchema).default([]),
	steps: z.array(StepSchema).min(1),
	stats: z
		.object({
			runs: z.number().int().min(0).default(0),
			passes: z.number().int().min(0).default(0),
			lastRunAt: z.string().optional(),
		})
		.optional(),
	selfHealed: z.array(SelfHealSchema).default([]),
})
export type Flow = z.infer<typeof FlowSchema>

/* ------------------------------------------------------------------ */
/* 契约校验（zod refine + 单测）                                        */
/* ------------------------------------------------------------------ */

const TEMPLATE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** 提取模板变量名；格式错误（未闭合/非法名）抛错由调用方转成 zod issue */
export function parseTemplate(value: string): string[] {
	const names: string[] = []
	const stripped = value.replace(TEMPLATE_RE, (_m, name: string) => {
		names.push(name)
		return ''
	})
	if (stripped.includes('{{') || stripped.includes('}}'))
		throw new Error('模板语法错误：存在未闭合的 {{ }}')
	return names
}

/** 用变量值渲染模板；缺失变量抛错（回放时应显式失败而不是填空串） */
export function resolveTemplate(value: string, vars: Record<string, string>): string {
	return value.replace(TEMPLATE_RE, (_m, name: string) => {
		if (!(name in vars)) throw new Error(`缺少变量 "${name}"`)
		return vars[name] as string
	})
}

const SAFE_REL_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/

/** 深遍历 flow，做跨字段契约校验（ElementRef 排序 / 路径安全 / 密码明文） */
export function validateFlowContract(flow: Flow): string[] {
	const errors: string[] = []
	const visitRef = (ref: ElementRef, where: string): void => {
		for (let i = 1; i < ref.candidates.length; i++) {
			const prev = ref.candidates[i - 1]!
			const cur = ref.candidates[i]!
			if (cur.score < prev.score) {
				errors.push(`${where}: candidates 必须按 score 升序（第 ${i} 项违反）`)
				break
			}
		}
		if (ref.crop && !SAFE_REL_PATH.test(ref.crop.ref)) {
			errors.push(`${where}: crop.ref 必须是安全的相对路径，收到 "${ref.crop.ref}"`)
		}
		for (const seg of ref.frame.path) {
			if (seg.kind === 'frameElement') visitAnchor(seg.anchor, `${where}.frame`)
		}
	}
	const visitAnchor = (a: FrameAnchor, where: string): void => {
		for (let i = 1; i < a.candidates.length; i++) {
			const prev = a.candidates[i - 1]!
			const cur = a.candidates[i]!
			if (cur.score < prev.score) {
				errors.push(`${where}: anchor candidates 必须按 score 升序`)
				break
			}
		}
	}
	const visitStep = (step: Step, where: string): void => {
		switch (step.kind) {
			case 'click':
			case 'hover':
				visitRef(step.target, `${where}.target`)
				break
			case 'input': {
				visitRef(step.target, `${where}.target`)
				const type = step.target.observed.attributes['type']
				if (type === 'password') {
					try {
						const names = parseTemplate(step.value)
						if (names.length === 0)
							errors.push(`${where}: password 输入必须是 {{变量}} 模板，不能落明文`)
					} catch {
						errors.push(`${where}: password 输入的模板语法错误`)
					}
				} else {
					try {
						parseTemplate(step.value)
					} catch {
						errors.push(`${where}: value 模板语法错误`)
					}
				}
				break
			}
			case 'select':
			case 'upload':
			case 'extract':
			case 'assert':
				if ('target' in step && step.target) visitRef(step.target, `${where}.target`)
				break
			case 'key':
			case 'wait':
			case 'scroll':
				if (step.target) visitRef(step.target, `${where}.target`)
				break
			case 'drag':
				visitRef(step.from, `${where}.from`)
				if (step.to.target) visitRef(step.to.target, `${where}.to.target`)
				break
			case 'group':
				step.steps.forEach((s, i) => visitStep(s, `${where}.steps[${i}]`))
				break
			default:
				break
		}
		if (step.expect) visitExpect(step.expect, `${where}.expect`)
	}
	const visitExpect = (e: Expect, where: string): void => {
		if (e.kind === 'urlChange' || e.kind === 'domSignature') return
		visitRef(e.target, `${where}.target`)
	}
	flow.steps.forEach((s, i) => visitStep(s, `steps[${i}]`))
	return errors
}
