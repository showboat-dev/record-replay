/**
 * 下载管理：把 Playwright 的 `download` 事件落到 artifact 目录，并给 expect 提供数据源。
 *
 * 关键设计：
 * - 文件名在**事件到达时**就确定并登记（`cursor` 立刻前进），保存动作异步进行；
 *   `expect.download` 轮询才不会被"文件还没写完"卡住；
 * - `since(cursor)` 只返回**当前步骤开始之后**的下载，避免上一步的下载把这一步的校验"蒙混过关"；
 * - 同名去重（`a.txt` / `a-1.txt`）；文件名过安全清洗（站点响应头不可信）。
 */
import type { BrowserContext, Download } from 'playwright'

import type { ArtifactWriter } from './artifacts.js'
import { uniqueDownloadFilename } from './artifacts.js'

export interface DownloadRecord {
	filename: string
	/** 落盘绝对路径（保存完成前为空字符串） */
	path: string
	at: number
	/** 归属的 step 序号（由 run.ts 在事件到达时写入） */
	stepIndex?: number
}

export interface DownloadManagerOptions {
	/** 当前 step 序号（事件到达时读取，用于归因） */
	stepIndex?: () => number
	/** 生成保存任务；默认用 playwright 的 download.saveAs */
	save?: (download: Download, absPath: string) => Promise<void>
}

export class DownloadManager {
	readonly #artifacts: ArtifactWriter
	readonly #log: (msg: string) => void
	readonly #options: DownloadManagerOptions
	readonly #records: DownloadRecord[] = []
	readonly #used = new Set<string>()
	readonly #pending: Array<Promise<void>> = []

	constructor(
		artifacts: ArtifactWriter,
		log: (msg: string) => void = () => {},
		options: DownloadManagerOptions = {},
	) {
		this.#artifacts = artifacts
		this.#log = log
		this.#options = options
	}

	/** 挂到 context 上（page 级事件会冒泡到 context，一次即可覆盖所有标签页） */
	attach(context: BrowserContext): void {
		context.on('download', (download) => this.track(download))
	}

	/** 也可直接喂事件（单测/自定义来源用） */
	track(download: Pick<Download, 'suggestedFilename' | 'saveAs'>): DownloadRecord {
		const suggested = download.suggestedFilename()
		const filename = uniqueDownloadFilename(suggested, this.#used)
		this.#used.add(filename)
		const record: DownloadRecord = {
			filename,
			path: '',
			at: Date.now(),
			...(this.#options.stepIndex ? { stepIndex: this.#options.stepIndex() } : {}),
		}
		this.#records.push(record)
		this.#log(`下载：${suggested} → ${filename}`)

		const save = this.#options.save ?? ((dl, absPath) => dl.saveAs(absPath))
		const task = (async () => {
			try {
				record.path = await this.#artifacts.writeDownload(filename, (absPath) =>
					save(download as Download, absPath),
				)
			} catch (err) {
				this.#log(`下载保存失败（${filename}）：${(err as Error).message}`)
			}
		})()
		this.#pending.push(task)
		return record
	}

	/** 当前游标：捕获它 → 之后发生的下载就是"这一步的下载" */
	get cursor(): number {
		return this.#records.length
	}

	/** 游标之后的下载文件名（给 verify 的 recentDownloads 用） */
	since(cursor: number): string[] {
		return this.#records.slice(Math.max(0, cursor)).map((record) => record.filename)
	}

	list(): DownloadRecord[] {
		return [...this.#records]
	}

	get count(): number {
		return this.#records.length
	}

	/** 等所有保存任务落盘（写 result.json 前调用） */
	async flush(): Promise<void> {
		await Promise.allSettled([...this.#pending])
	}
}
