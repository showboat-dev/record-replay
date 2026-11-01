import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { FlowSchema, SCHEMA_VERSION, validateFlowContract, type Flow } from './schema.js'

export class FlowValidationError extends Error {
	readonly issues: string[]
	constructor(source: string, issues: string[]) {
		super(`flow 校验失败（${source}）:\n  - ${issues.join('\n  - ')}`)
		this.name = 'FlowValidationError'
		this.issues = issues
	}
}

/** 把任意输入规范化成当前版本的 Flow；失败抛 FlowValidationError */
export function parseFlow(input: unknown, source = '<memory>'): Flow {
	const migrated = migrateFlow(input)
	const parsed = FlowSchema.safeParse(migrated)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
		throw new FlowValidationError(source, issues)
	}
	const contractIssues = validateFlowContract(parsed.data)
	if (contractIssues.length) throw new FlowValidationError(source, contractIssues)
	return parsed.data
}

/**
 * 版本迁移。v0（无 schemaVersion）→ v1：补默认字段。
 * 未来加版本时在这里逐级升级，保证老 flow 能继续跑。
 */
export function migrateFlow(raw: unknown): unknown {
	if (typeof raw !== 'object' || raw === null) return raw
	const doc = { ...(raw as Record<string, unknown>) }
	const version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0
	if (version === SCHEMA_VERSION) return doc
	if (version === 0) {
		return {
			...doc,
			schemaVersion: SCHEMA_VERSION,
			version: typeof doc.version === 'number' ? doc.version : 1,
			selfHealed: Array.isArray(doc.selfHealed) ? doc.selfHealed : [],
		}
	}
	if (version > SCHEMA_VERSION) {
		throw new Error(`flow 版本 ${version} 高于当前支持的 ${SCHEMA_VERSION}，请升级 rr`)
	}
	throw new Error(`未知的 flow 版本 ${version}`)
}

export async function loadFlow(file: string): Promise<Flow> {
	const text = await readFile(file, 'utf8')
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (err) {
		throw new Error(`无法解析 flow（${file}）：${(err as Error).message}`)
	}
	return parseFlow(raw, file)
}

export function serializeFlow(flow: Flow): string {
	return `${JSON.stringify(flow, null, 2)}\n`
}

export interface SaveOptions {
	/** 覆盖前把旧文件复制成 .bak（自愈写回时使用） */
	backup?: boolean
}

export async function saveFlow(flow: Flow, file: string, opts: SaveOptions = {}): Promise<void> {
	// 写前校验：绝不让非法 IR 落盘
	const validated = parseFlow(flow, file)
	await mkdir(dirname(file), { recursive: true })
	if (opts.backup) {
		try {
			await copyFile(file, `${file}.bak`)
		} catch {
			/* 首次写入没有旧文件，忽略 */
		}
	}
	const tmp = `${file}.tmp`
	await writeFile(tmp, serializeFlow(validated), 'utf8')
	await rename(tmp, file)
}

/** 生成稳定 id（time + random，够用且无需 uuid 依赖） */
export function makeId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
