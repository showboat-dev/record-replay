import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactWriter, DownloadManager, sanitizeDownloadName, uniqueDownloadFilename } from './index.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'rr-downloads-'))
	dirs.push(dir)
	return dir
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 假的 download 事件（只需要 suggestedFilename + saveAs） */
function fakeDownload(filename: string, content = 'payload') {
	return {
		suggestedFilename: () => filename,
		saveAs: async (absPath: string) => {
			const { writeFile } = await import('node:fs/promises')
			await writeFile(absPath, content)
		},
	} as unknown as Parameters<DownloadManager['track']>[0]
}

describe('executor: 下载文件名', () => {
	it('sanitizeDownloadName 去掉路径与危险字符', () => {
		expect(sanitizeDownloadName('report.pdf')).toBe('report.pdf')
		expect(sanitizeDownloadName('../../etc/passwd')).toBe('passwd')
		expect(sanitizeDownloadName('C:\\temp\\a.txt')).toBe('a.txt')
		expect(sanitizeDownloadName('a:b?c.txt')).toBe('a_b_c.txt')
		expect(sanitizeDownloadName('')).toBe('download.bin')
		expect(sanitizeDownloadName('...hidden')).toBe('_hidden')
	})

	it('uniqueDownloadFilename 同名加序号且保留扩展名', () => {
		expect(uniqueDownloadFilename('a.txt', new Set())).toBe('a.txt')
		expect(uniqueDownloadFilename('a.txt', new Set(['a.txt']))).toBe('a-1.txt')
		expect(uniqueDownloadFilename('a.txt', new Set(['a.txt', 'a-1.txt']))).toBe('a-2.txt')
		expect(uniqueDownloadFilename('noext', new Set(['noext']))).toBe('noext-1')
	})
})

describe('executor: DownloadManager', () => {
	it('落盘到 downloads/ 并可用游标分段', async () => {
		const root = await tempDir()
		const artifacts = new ArtifactWriter(root, 'flow', 'run')
		const manager = new DownloadManager(artifacts)
		manager.track(fakeDownload('first.txt', 'ONE'))
		await manager.flush()

		const cursor = manager.cursor
		expect(cursor).toBe(1)
		expect(manager.since(cursor)).toEqual([])

		manager.track(fakeDownload('second.txt', 'TWO'))
		await manager.flush()

		expect(manager.since(cursor)).toEqual(['second.txt'])
		expect(manager.since(0)).toEqual(['first.txt', 'second.txt'])
		expect(manager.count).toBe(2)

		const files = (await readdir(artifacts.downloadsDir)).sort()
		expect(files).toEqual(['first.txt', 'second.txt'])
		expect(await readFile(join(artifacts.downloadsDir, 'first.txt'), 'utf8')).toBe('ONE')
	})

	it('同名下载自动加序号（不覆盖）', async () => {
		const root = await tempDir()
		const artifacts = new ArtifactWriter(root, 'flow', 'run')
		const manager = new DownloadManager(artifacts)
		manager.track(fakeDownload('report.csv', 'A'))
		manager.track(fakeDownload('report.csv', 'B'))
		await manager.flush()

		expect(manager.list().map((r) => r.filename)).toEqual(['report.csv', 'report-1.csv'])
		expect(await readFile(join(artifacts.downloadsDir, 'report.csv'), 'utf8')).toBe('A')
		expect(await readFile(join(artifacts.downloadsDir, 'report-1.csv'), 'utf8')).toBe('B')
	})

	it('危险文件名不会逃出 downloads 目录', async () => {
		const root = await tempDir()
		const artifacts = new ArtifactWriter(root, 'flow', 'run')
		const manager = new DownloadManager(artifacts)
		manager.track(fakeDownload('../escape.txt', 'X'))
		await manager.flush()
		expect(manager.list()[0]?.filename).toBe('escape.txt')
		expect(manager.list()[0]?.path.startsWith(artifacts.downloadsDir)).toBe(true)
	})

	it('保存失败只记日志，不抛（run 不应因下载失败整体崩）', async () => {
		const root = await tempDir()
		const logs: string[] = []
		const artifacts = new ArtifactWriter(root, 'flow', 'run')
		const manager = new DownloadManager(artifacts, (m) => logs.push(m), {
			save: async () => {
				throw new Error('disk full')
			},
		})
		manager.track(fakeDownload('x.bin'))
		await expect(manager.flush()).resolves.toBeUndefined()
		expect(logs.some((l) => l.includes('disk full'))).toBe(true)
		// 文件名仍然登记（verify 还能过）
		expect(manager.since(0)).toEqual(['x.bin'])
	})
})
