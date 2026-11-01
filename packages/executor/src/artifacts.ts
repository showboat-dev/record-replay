/**
 * Artifact 落盘（目录约定见 docs/architecture.md §2）：
 *
 *   artifacts/<flowId>/runs/<runId>/result.json
 *   artifacts/<flowId>/runs/<runId>/<stepIndex>/{before.png,after.png,snapshot.json,log.txt}
 *
 * 安全：所有路径都过 `sanitizeSegment`（flowId/runId 来自 IR/参数，可能是恶意字符串），
 * `safePath` 再兜一层，确保绝对路径永远落在 runDir 之内。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** 把任意字符串压成安全的单段路径：只保留 [\w.-]，去掉开头的点，限长 80 */
export function sanitizeSegment(value: string): string {
	const cleaned = value
		.replace(/\.{2,}/g, '_')
		.replace(/[^\w.-]+/g, '_')
		.replace(/^\.+/, '_')
		.slice(0, 80)
	return cleaned.length > 0 ? cleaned : 'unnamed'
}

export interface StepArtifactPayload {
	before?: Buffer
	after?: Buffer
	/** 已经序列化好的对象，写成 snapshot.json */
	snapshot: unknown
	/** 逐行日志，写成 log.txt */
	log: string[]
	element?: Buffer
}

export class ArtifactWriter {
	readonly root: string
	readonly flowDir: string
	readonly runDir: string

	constructor(root: string, flowId: string, runId: string) {
		this.root = resolve(root)
		this.flowDir = join(this.root, sanitizeSegment(flowId))
		this.runDir = join(this.flowDir, 'runs', sanitizeSegment(runId))
	}

	/** 保证相对路径不越狱，返回绝对路径 */
	safePath(relPath: string): string {
		const abs = resolve(this.runDir, relPath)
		const rel = relative(this.runDir, abs)
		if (rel.startsWith('..') || isAbsolute(rel)) {
			throw new Error(`artifact 路径越界：${relPath}`)
		}
		return abs
	}

	async writeText(relPath: string, content: string): Promise<string> {
		const abs = this.safePath(relPath)
		await mkdir(dirname(abs), { recursive: true })
		await writeFile(abs, content, 'utf8')
		return abs
	}

	async writeBuffer(relPath: string, content: Buffer): Promise<string> {
		const abs = this.safePath(relPath)
		await mkdir(dirname(abs), { recursive: true })
		await writeFile(abs, content)
		return abs
	}

	/** 落一个 step 的全部证据；返回该 step 的绝对目录 */
	async writeStepArtifacts(index: number, payload: StepArtifactPayload): Promise<string> {
		const stepDir = join(this.runDir, String(index))
		await mkdir(stepDir, { recursive: true })
		if (payload.before) await writeFile(join(stepDir, 'before.png'), payload.before)
		if (payload.after) await writeFile(join(stepDir, 'after.png'), payload.after)
		if (payload.element) await writeFile(join(stepDir, 'element.png'), payload.element)
		await writeFile(join(stepDir, 'snapshot.json'), `${JSON.stringify(payload.snapshot, null, 2)}\n`, 'utf8')
		await writeFile(join(stepDir, 'log.txt'), `${payload.log.join('\n')}\n`, 'utf8')
		return stepDir
	}

	async writeResult(report: unknown): Promise<string> {
		return this.writeText('result.json', `${JSON.stringify(report, null, 2)}\n`)
	}
}
