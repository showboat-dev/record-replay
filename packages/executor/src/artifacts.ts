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

/**
 * 下载文件名清洗：去掉目录分隔符与路径穿越，保留可读原名。
 * 浏览器给的 `suggestedFilename()` 可能来自站点响应头（不可信），必须过一遍。
 */
export function sanitizeDownloadName(name: string): string {
	const base =
		name
			.replace(/\\/g, '/')
			.split('/')
			.pop() ?? ''
	// 逐字符清洗：控制字符与 Windows 非法字符换成 _（不用正则，避免 no-control-regex）
	const cleaned = Array.from(base)
		.map((ch) => {
			const code = ch.codePointAt(0) ?? 0
			if (code < 0x20 || code === 0x7f) return '_'
			return '<>:"|?*'.includes(ch) ? '_' : ch
		})
		.join('')
		.replace(/^\.+/, '_')
		.trim()
	if (cleaned === '') return 'download.bin'
	return cleaned.slice(0, 120)
}

/**
 * 同名下载去重：`a.txt` 已存在 → `a-1.txt` → `a-2.txt`。
 * 纯函数（传入已用名字集合），便于单测；扩展名保留在末尾便于业务人员辨认。
 */
export function uniqueDownloadFilename(name: string, used: ReadonlySet<string>): string {
	const sanitized = sanitizeDownloadName(name)
	if (!used.has(sanitized)) return sanitized
	const dot = sanitized.lastIndexOf('.')
	const stem = dot > 0 ? sanitized.slice(0, dot) : sanitized
	const ext = dot > 0 ? sanitized.slice(dot) : ''
	for (let index = 1; index < 10_000; index++) {
		const candidate = `${stem}-${index}${ext}`
		if (!used.has(candidate)) return candidate
	}
	return `${stem}-${Date.now()}${ext}`
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

/** artifacts 目录布局：单次回放走 runs/，批量走 batches/<batchId>/row-<index>/ */
export type ArtifactLayout =
	| { kind: 'runs' }
	| { kind: 'batches'; batchId: string; rowIndex: number | string }

export class ArtifactWriter {
	readonly root: string
	readonly flowDir: string
	readonly runDir: string

	constructor(
		root: string,
		flowId: string,
		runId: string,
		layout: ArtifactLayout = { kind: 'runs' },
	) {
		this.root = resolve(root)
		this.flowDir = join(this.root, sanitizeSegment(flowId))
		this.runDir =
			layout.kind === 'runs'
				? join(this.flowDir, 'runs', sanitizeSegment(runId))
				: join(
						this.flowDir,
						'batches',
						sanitizeSegment(layout.batchId),
						`row-${sanitizeSegment(String(layout.rowIndex))}`,
					)
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
		await writeFile(
			join(stepDir, 'snapshot.json'),
			`${JSON.stringify(payload.snapshot, null, 2)}\n`,
			'utf8',
		)
		await writeFile(join(stepDir, 'log.txt'), `${payload.log.join('\n')}\n`, 'utf8')
		return stepDir
	}

	/** 批次的根目录：`artifacts/<flowId>/batches/<batchId>/`（行目录在它下面的 row-<index>/） */
	static batchRoot(root: string, flowId: string, batchId: string): string {
		return join(resolve(root), sanitizeSegment(flowId), 'batches', sanitizeSegment(batchId))
	}

	/** 下载目录：`artifacts/<flowId>/runs/<runId>/downloads/` */
	get downloadsDir(): string {
		return join(this.runDir, 'downloads')
	}

	/**
	 * 把一个下载落到 `downloads/<filename>`，由调用方提供真正的保存动作
	 * （Playwright 的 `download.saveAs(path)`，或测试里写个假文件）。
	 */
	async writeDownload(
		filename: string,
		writer: (absPath: string) => Promise<void>,
	): Promise<string> {
		const safe = sanitizeDownloadName(filename)
		const abs = resolve(this.downloadsDir, safe)
		const rel = relative(this.downloadsDir, abs)
		if (rel.startsWith('..') || isAbsolute(rel)) {
			throw new Error(`下载路径越界：${filename}`)
		}
		await mkdir(this.downloadsDir, { recursive: true })
		await writer(abs)
		return abs
	}

	async writeResult(report: unknown): Promise<string> {
		return this.writeText('result.json', `${JSON.stringify(report, null, 2)}\n`)
	}
}
