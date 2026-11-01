/**
 * 路径 / 时间戳小工具（harness 内部共用）。
 *
 * `flows/xxx.json` 这类仓库内相对路径一律以**仓库根目录**为基准解析，而不是 `process.cwd()`：
 * harness 既可以从仓库根跑（`pnpm harness`），也可以从任意子目录跑（`pnpm rr harness`），
 * 用 cwd 会让后者直接找不到 flow。
 */
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'

/** `packages/harness/src/paths.ts` → 仓库根（rr/） */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** 仓库内相对路径 → 绝对路径（绝对路径原样返回） */
export function resolveFromRoot(filePath: string, rootDir: string = REPO_ROOT): string {
	return isAbsolute(filePath) ? filePath : resolve(rootDir, filePath)
}

/**
 * 报告目录名的时间戳：`20261101-153210`（本地时间、可排序、文件名安全）。
 * 不用 `toISOString()` 是因为它带 `:`，在做目录名时需要额外转义。
 */
export function formatStamp(date: Date): string {
	const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
	const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
	const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	return `${ymd}-${hms}`
}

/** 展示用的相对路径（相对仓库根），绝对路径在仓库外时原样返回 */
export function displayPath(filePath: string, rootDir: string = REPO_ROOT): string {
	if (!isAbsolute(filePath)) return filePath
	const prefix = rootDir.endsWith('/') ? rootDir : `${rootDir}/`
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
}
