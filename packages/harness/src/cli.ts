/**
 * `pnpm harness` 的独立入口（root package.json 的 `harness` script 指向这里）。
 *
 * 与 `rr harness` 共用 `runHarnessCommand`，所以两个入口的行为/退出码完全一致，
 * 差别只是这个入口不经过 `@rr/cli`。
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import pc from 'picocolors'

import type { RepairClient } from '@rr/ai'

import { runHarnessCommand } from './command.js'
import type { SiteMode } from './sites.js'
import { reportLooksNotImplemented } from './verdict.js'

const USAGE = `
${pc.bold('pnpm harness')} — 回归集：批量回放本地/公开站并产出报告

${pc.bold('用法')}
  pnpm harness [--runs 10] [--sites local|all|public] [--out <dir>] [--ai] [--json]

${pc.bold('选项')}
  --runs <n>  每站回放次数（默认 10；回归集要的是分布，不是单次）
  --sites     本地 11 条（local，默认）/ 全部 20 条（all）/ 只跑公开站（public）
              公开站需要联网且 flow 已录制；没有 flow 的标成 skipped，不会真的联网
  --out <dir> artifact 根目录（默认 <仓库根>/artifacts），报告落在 <out>/harness-<时间戳>/
  --ai        启用 AI 兜底（需要 RR_AI_ENABLED=1 等环境变量，未启用会自动降级）
  --json      stdout 只输出 report.json（人话摘要改走 stderr）

${pc.bold('退出码')}  0 全绿 / 1 有回归或站点无法运行 / 2 用法错误
`

interface CliValues {
	runs?: string
	sites?: string
	out?: string
	ai?: boolean
	json?: boolean
	help?: boolean
}

function usageError(message: string): never {
	console.error(pc.red(`用法错误：${message}`))
	console.error(USAGE)
	process.exit(2)
}

function parseCliArgs(): CliValues {
	try {
		const { values } = parseArgs({
			args: process.argv.slice(2),
			allowPositionals: false,
			options: {
				runs: { type: 'string' },
				sites: { type: 'string' },
				out: { type: 'string' },
				ai: { type: 'boolean', default: false },
				json: { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false },
			},
		})
		return values
	} catch (error) {
		usageError(error instanceof Error ? error.message : String(error))
	}
}

function parseMode(value: string | undefined): SiteMode {
	const mode = value ?? 'local'
	if (mode === 'local' || mode === 'all' || mode === 'public') return mode
	usageError(`--sites 只支持 local / all / public，收到 "${mode}"`)
}

function parseRuns(value: string | undefined): number {
	const raw = value ?? '10'
	const runs = Number(raw)
	if (!Number.isInteger(runs) || runs < 1) usageError(`--runs 必须是 >= 1 的整数，收到 "${raw}"`)
	return runs
}

async function createAiClient(enabled: boolean): Promise<RepairClient | null> {
	if (!enabled) return null
	const { createRepairClient } = (await import('@rr/ai')) as typeof import('@rr/ai')
	const client = createRepairClient()
	if (!client) {
		console.error(
			pc.yellow(
				'提示：--ai 已指定，但 AI 未启用（需要 RR_AI_ENABLED=1 + RR_AI_BASE_URL/KEY/MODEL），本次按纯本地路径跑。',
			),
		)
	}
	return client
}

async function main(): Promise<number> {
	const values = parseCliArgs()
	if (values.help) {
		console.log(USAGE)
		return 0
	}

	const mode = parseMode(values.sites)
	const runs = parseRuns(values.runs)
	const ai = await createAiClient(Boolean(values.ai))
	const out = values.out ? resolve(values.out) : undefined
	const json = Boolean(values.json)

	const result = await runHarnessCommand({
		sites: mode,
		runs,
		ai,
		quiet: json,
		...(out ? { artifactsRoot: out } : {}),
	})

	if (json) {
		// stdout 只留纯 JSON（`pnpm harness --json > report.json` 不会被摘要污染）
		for (const line of result.summary) console.error(line)
		console.log(JSON.stringify(result.report, null, 2))
	}

	if (reportLooksNotImplemented(result.report)) {
		console.error(
			pc.yellow('提示：executor 尚未实现，本次所有站点都无法运行。等 T5 完成后即可产出真实回归数据。'),
		)
	}
	return result.exitCode
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(pc.red(error instanceof Error ? (error.stack ?? error.message) : String(error)))
		process.exit(1)
	})
