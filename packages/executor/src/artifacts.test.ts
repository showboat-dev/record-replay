import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactWriter, sanitizeSegment } from './index.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'rr-artifacts-'))
	dirs.push(dir)
	return dir
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('executor: artifact 目录与路径安全', () => {
	it('sanitizeSegment 去掉路径分隔符与开头的点', () => {
		expect(sanitizeSegment('../../etc/passwd')).not.toContain('/')
		expect(sanitizeSegment('../../etc/passwd').startsWith('.')).toBe(false)
		expect(sanitizeSegment('a b/c')).toBe('a_b_c')
		expect(sanitizeSegment('')).toBe('unnamed')
		expect(sanitizeSegment('...hidden')).toBe('_hidden')
	})

	it('flowId 里带 ../ 也不会逃出 root', async () => {
		const root = await tempDir()
		const writer = new ArtifactWriter(root, '../../escape', '../run')
		expect(writer.runDir.startsWith(root)).toBe(true)
		expect(writer.runDir.includes('..')).toBe(false)
	})

	it('safePath 拒绝越界相对路径', async () => {
		const root = await tempDir()
		const writer = new ArtifactWriter(root, 'flow', 'run')
		expect(() => writer.safePath('../../evil.txt')).toThrow(/越界/)
		expect(writer.safePath('0/log.txt').startsWith(writer.runDir)).toBe(true)
	})

	it('writeStepArtifacts 落 before/after/snapshot/log 四个文件', async () => {
		const root = await tempDir()
		const writer = new ArtifactWriter(root, 'demo-flow', 'run_1')
		const stepDir = await writer.writeStepArtifacts(2, {
			before: Buffer.from('BEFORE'),
			after: Buffer.from('AFTER'),
			snapshot: { url: 'http://x.test/basic', ok: false },
			log: ['line-1', 'line-2'],
		})

		expect(stepDir).toBe(join(writer.runDir, '2'))
		expect((await readdir(stepDir)).sort()).toEqual([
			'after.png',
			'before.png',
			'log.txt',
			'snapshot.json',
		])
		expect(await readFile(join(stepDir, 'before.png'), 'utf8')).toBe('BEFORE')
		expect(await readFile(join(stepDir, 'after.png'), 'utf8')).toBe('AFTER')
		expect(JSON.parse(await readFile(join(stepDir, 'snapshot.json'), 'utf8'))).toMatchObject({
			url: 'http://x.test/basic',
		})
		expect(await readFile(join(stepDir, 'log.txt'), 'utf8')).toBe('line-1\nline-2\n')
	})

	it('writeResult 写到 runDir/result.json', async () => {
		const root = await tempDir()
		const writer = new ArtifactWriter(root, 'demo-flow', 'run_2')
		expect(writer.root).toBe(root)
		const file = await writer.writeResult({ ok: true, steps: [] })
		expect(file).toBe(join(root, 'demo-flow', 'runs', 'run_2', 'result.json'))
		expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ ok: true })
	})

	it('缺 before/after 时只写 snapshot 与 log', async () => {
		const root = await tempDir()
		const writer = new ArtifactWriter(root, 'f', 'r')
		const stepDir = await writer.writeStepArtifacts(0, { snapshot: {}, log: [] })
		expect((await readdir(stepDir)).sort()).toEqual(['log.txt', 'snapshot.json'])
	})
})
