import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import pc from 'picocolors'

import type { RepairClient } from '@rr/ai'
import { reportLooksNotImplemented, runHarnessCommand } from '@rr/harness'
import { loadFlow, type Flow, type Step } from '@rr/schema'

const USAGE = `
${pc.bold('rr')} — 网页操作录制回放引擎（record & replay）

${pc.bold('用法')}
  rr record  --url <url> --out flows/<id>.json [--viewport 1440x900] [--headless] [--keep-raw]
  rr play    flows/<id>.json [--runs 3] [--headed] [--ai] [--var k=v]... [--write-back] [--artifacts ./artifacts] [--json]
  rr inspect flows/<id>.json
  rr harness [--runs 10] [--sites local|all|public] [--out artifacts] [--ai] [--json]

${pc.bold('harness')}（回归集）
  --runs <n>  每站回放次数（默认 10）
  --sites     本地 11 条（local，默认）/ 全部（all）/ 只跑公开站（public）
  --out       artifact 根目录（默认 ./artifacts），报告落在 <out>/harness-<时间戳>/
  --json      stdout 只输出 report.json，人话摘要走 stderr

${pc.bold('退出码')}  0 成功 / 1 运行失败 / 2 用法错误
`

type CliValues = Record<string, string | boolean | undefined>

function usageError(msg: string): never {
	console.error(pc.red(`用法错误：${msg}`))
	console.error(USAGE)
	process.exit(2)
}

/** parseArgs 的统一包装：未知参数/缺值也算用法错误（退出码 2），而不是冒到顶层的 1 */
function parseCliOptions(
	args: string[],
	options: Record<
		string,
		{ type: 'string' | 'boolean'; default?: string | boolean; short?: string; multiple?: boolean }
	>,
): { values: CliValues; positionals: string[] } {
	try {
		const { values, positionals } = parseArgs({ args, allowPositionals: true, options })
		return { values: values as CliValues, positionals }
	} catch (error) {
		usageError(error instanceof Error ? error.message : String(error))
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2)
	const command = argv[0]

	if (!command || command === '--help' || command === '-h' || command === 'help') {
		console.log(USAGE)
		return
	}

	switch (command) {
		case 'inspect':
			await inspect(argv.slice(1))
			return
		case 'record':
			await recordCmd(argv.slice(1))
			return
		case 'play':
			await playCmd(argv.slice(1))
			return
		case 'harness':
			await harnessCmd(argv.slice(1))
			return
		case 'studio':
			await studioCmd(argv.slice(1))
			return
		default:
			usageError(`未知命令 "${command}"`)
	}
}

/**
 * 读 flow 的统一入口：
 * - 文件不存在 → 退出码 2（属于用法问题，附一条怎么录制的提示）；
 * - 文件存在但校验失败 → 退出码 1（属于数据问题，打印校验错误明细）。
 */
async function loadFlowOrExit(file: string): Promise<Flow> {
	const abs = resolve(file)
	try {
		await access(abs)
	} catch {
		usageError(`找不到 flow 文件：${file}（先录一条：rr record --url <url> --out ${file}）`)
	}
	try {
		return await loadFlow(abs)
	} catch (error) {
		// loadFlow 的报错本身已经带文件名和明细（"flow 校验失败（<file>）: ..."），不要再套一层前缀
		console.error(pc.red(error instanceof Error ? error.message : String(error)))
		process.exit(1)
	}
}

async function inspect(args: string[]): Promise<void> {
	const { positionals } = parseCliOptions(args, {})
	const file = positionals[0]
	if (!file) usageError('inspect 需要一个 flow 文件路径')
	const flow = await loadFlowOrExit(file)
	printFlow(flow)
}

function printFlow(flow: Flow): void {
	console.log(pc.bold(`\n${flow.title}`) + pc.dim(`  (${flow.id} v${flow.version})`))
	console.log(
		pc.dim(
			`  env: ${flow.meta.env.viewport.width}x${flow.meta.env.viewport.height} @${flow.meta.env.dpr}x  ${flow.meta.env.startUrl}`,
		),
	)
	const lines = flatten(flow.steps)
	lines.forEach(({ step, depth }) => {
		const pad = '  '.repeat(depth + 1)
		const expect = step.expect ? pc.cyan(` → ${step.expect.kind}`) : ''
		console.log(`${pad}${pc.dim(String(step.id).padEnd(8))} ${describeStep(step)}${expect}`)
	})
	console.log('')
}

function flatten(steps: Step[], depth = 0): Array<{ step: Step; depth: number }> {
	const out: Array<{ step: Step; depth: number }> = []
	for (const step of steps) {
		out.push({ step, depth })
		if (step.kind === 'group') out.push(...flatten(step.steps, depth + 1))
	}
	return out
}

function describeStep(step: Step): string {
	switch (step.kind) {
		case 'navigate':
			return `navigate  ${step.url}`
		case 'click':
			return `click     ${targetLabel(step.target)}`
		case 'input':
			return `input     ${targetLabel(step.target)} ← ${JSON.stringify(step.value)}`
		case 'select':
			return `select    ${targetLabel(step.target)} ← ${JSON.stringify(step.value)}`
		case 'key':
			return `key       ${step.key}`
		case 'hover':
			return `hover     ${targetLabel(step.target)}`
		case 'scroll':
			return `scroll    ${step.target ? targetLabel(step.target) : 'page'} ${JSON.stringify(step.to ?? step.delta ?? {})}`
		case 'drag':
			return `drag      ${targetLabel(step.from)}`
		case 'upload':
			return `upload    ${targetLabel(step.target)} ← ${step.files.join(', ')}`
		case 'wait':
			return `wait      ${step.condition}${step.ms ? ` ${step.ms}ms` : ''}`
		case 'assert':
			return `assert    ${step.assertion.kind}`
		case 'extract':
			return `extract   ${targetLabel(step.target)} → {{${step.into}}}`
		case 'script':
			return 'script    <inline>'
		case 'dialog':
			return `dialog    ${step.action}${step.promptText ? ` ← ${JSON.stringify(step.promptText)}` : ''}`
		case 'switchTab':
			return `switchTab 第 ${step.index + 1} 个标签页`
		case 'group':
			return pc.bold(`group     ${step.label}`)
	}
}

function targetLabel(target: import('@rr/schema').ElementRef): string {
	const fp = target.fingerprint
	const best = target.candidates[0]
	const bestText = best ? `${best.kind}=${JSON.stringify(best.value)}` : '<none>'
	const name = fp.accessibleName ? ` "${fp.accessibleName}"` : ''
	return `${fp.tag}${name} ${pc.dim(`(${bestText})`)}`
}

function notImplemented(what: string): never {
	console.error(pc.yellow(`${what} 尚未实现（该 package 正在并行开发中）。`))
	console.error(pc.dim('先用 `rr inspect` 查看 flow，或等待 M1 完成。'))
	process.exit(1)
}

/** `--ai` → RepairClient；未配置时返回 null（executor 走纯本地路径） */
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

function parseIntegerFlag(
	raw: string | boolean | undefined,
	name: string,
	fallback: number,
): number {
	const value = Number(raw ?? fallback)
	if (!Number.isInteger(value) || value < 1)
		usageError(`${name} 必须是 >= 1 的整数，收到 "${String(raw)}"`)
	return value
}

async function recordCmd(args: string[]): Promise<void> {
	const { values } = parseCliOptions(args, {
		url: { type: 'string' },
		out: { type: 'string' },
		viewport: { type: 'string' },
		headless: { type: 'boolean', default: false },
		'keep-raw': { type: 'boolean', default: false },
		artifacts: { type: 'string' },
	})
	const url = values['url'] as string | undefined
	const out = values['out'] as string | undefined
	if (!url) usageError('record 需要 --url')
	if (!out) usageError('record 需要 --out')

	try {
		const { record } = (await import('@rr/recorder')) as typeof import('@rr/recorder')
		const viewport = parseViewport(values['viewport'] as string | undefined)
		const result = await record({
			startUrl: url,
			outPath: resolve(out),
			...(viewport ? { viewport } : {}),
			headless: Boolean(values['headless']),
			keepRaw: Boolean(values['keep-raw']),
			...(values['artifacts'] ? { artifactsRoot: values['artifacts'] as string } : {}),
			onStep: (step) => {
				console.log(pc.dim(`  + ${step.kind} ${step.id}`))
			},
		})
		console.log(pc.green(`\n✓ 已录制 ${result.flow.steps.length} 步 → ${out}`))
	} catch (err) {
		if (isMissingModule(err, '@rr/recorder')) notImplemented('record')
		throw err
	}
}

async function playCmd(args: string[]): Promise<void> {
	const { values, positionals } = parseCliOptions(args, {
		runs: { type: 'string', default: '1' },
		headed: { type: 'boolean', default: false },
		ai: { type: 'boolean', default: false },
		headless: { type: 'boolean', default: false },
		'write-back': { type: 'boolean', default: false },
		artifacts: { type: 'string' },
		json: { type: 'boolean', default: false },
		var: { type: 'string', multiple: true },
	})
	const file = positionals[0]
	if (!file) usageError('play 需要一个 flow 文件路径')
	const runs = parseIntegerFlag(values['runs'], '--runs', 1)
	const writeBack = Boolean(values['write-back'])
	const variables = parseVariables(values['var'])

	try {
		const { playRuns } = (await import('@rr/executor')) as typeof import('@rr/executor')
		const flowPath = resolve(file)
		const flow = await loadFlowOrExit(file)
		const ai = await createAiClient(Boolean(values['ai']))
		// executor 正在并行实现：`writeBack` / `flowPath` 可能还没进 PlayOptions 类型，
		// 用交叉类型透传，等它加上之后这里一行都不用改。
		type PlayOptionsWithWriteBack = Parameters<typeof playRuns>[0] & {
			writeBack?: boolean
			flowPath?: string
		}
		const options: PlayOptionsWithWriteBack = {
			flow,
			// 自愈写回需要知道写哪个文件（executor 的 writeBack=true 硬性要求）
			flowPath,
			headless: !values['headed'],
			runs,
			ai,
			...(variables ? { variables } : {}),
			...(values['artifacts'] ? { artifactsRoot: values['artifacts'] as string } : {}),
			...(writeBack ? { writeBack: true } : {}),
			// 日志走 stderr，保证 --json 时 stdout 只有 JSON
			onLog: (msg: string) => console.error(pc.dim(`  ${msg}`)),
		}
		const results = await playRuns(options)
		if (writeBack) {
			console.error(
				pc.yellow('提示：--write-back 已开启，自愈结果会写回 flow（写前备份为 .bak，version+1）。'),
			)
		}
		if (values['json']) {
			console.log(JSON.stringify(results, null, 2))
		} else {
			const passed = results.filter((r) => r.ok).length
			for (const r of results) {
				const mark = r.ok ? pc.green('✓') : pc.red('✗')
				console.log(
					`${mark} run ${r.runId}  ${r.metrics.passCount}/${r.steps.length}  ${r.metrics.totalMs}ms`,
				)
			}
			console.log(`\n${passed}/${results.length} 通过`)
		}
		process.exit(results.every((r) => r.ok) ? 0 : 1)
	} catch (err) {
		if (isMissingModule(err, '@rr/executor')) notImplemented('play')
		throw err
	}
}

async function studioCmd(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		allowPositionals: true,
		options: { port: { type: 'string' } },
	})
	if (values['port']) process.env.RR_STUDIO_PORT = String(values['port'])
	const { createStudioServer } = (await import('@rr/studio')) as typeof import('@rr/studio')
	await createStudioServer()
	// 保持进程存活
	await new Promise(() => {})
}

async function harnessCmd(args: string[]): Promise<void> {
	const { values } = parseCliOptions(args, {
		runs: { type: 'string', default: '10' },
		sites: { type: 'string', default: 'local' },
		out: { type: 'string' },
		ai: { type: 'boolean', default: false },
		json: { type: 'boolean', default: false },
	})
	const mode = values['sites'] as string
	if (mode !== 'local' && mode !== 'all' && mode !== 'public') {
		usageError(`--sites 只支持 local / all / public，收到 "${mode}"`)
	}
	const runs = parseIntegerFlag(values['runs'], '--runs', 10)
	const ai = await createAiClient(Boolean(values['ai']))
	const out = values['out'] as string | undefined
	const json = Boolean(values['json'])

	try {
		const result = await runHarnessCommand({
			sites: mode,
			runs,
			ai,
			quiet: json,
			...(out ? { artifactsRoot: resolve(out) } : {}),
		})

		if (json) {
			// stdout 只留纯 JSON，摘要走 stderr
			for (const line of result.summary) console.error(line)
			console.log(JSON.stringify(result.report, null, 2))
		}
		if (reportLooksNotImplemented(result.report)) {
			console.error(
				pc.yellow(
					'提示：executor 尚未实现，本次所有站点都无法运行。等 T5 完成后即可产出真实回归数据。',
				),
			)
		}
		process.exit(result.exitCode)
	} catch (err) {
		if (isMissingModule(err, '@rr/harness')) notImplemented('harness')
		throw err
	}
}

/** 解析 repeatable `--var name=value`（secret/变量驱动的 flow 回放用） */
function parseVariables(raw: unknown): Record<string, string> | undefined {
	const list = Array.isArray(raw) ? (raw as unknown[]) : raw === undefined ? [] : [raw]
	const out: Record<string, string> = {}
	for (const item of list) {
		const text = String(item)
		const eq = text.indexOf('=')
		if (eq <= 0) usageError(`--var 需要 name=value 形式，收到 "${text}"`)
		out[text.slice(0, eq)] = text.slice(eq + 1)
	}
	return Object.keys(out).length ? out : undefined
}

function parseViewport(value: string | undefined): { width: number; height: number } | undefined {
	if (!value) return undefined
	const m = /^(\d+)x(\d+)$/.exec(value)
	if (!m) usageError(`--viewport 格式应为 1440x900，收到 "${value}"`)
	return { width: Number(m[1]), height: Number(m[2]) }
}

function isMissingModule(err: unknown, pkg: string): boolean {
	const msg = err instanceof Error ? err.message : String(err)
	return msg.includes(pkg) || /Cannot find (module|package)/.test(msg)
}

main().catch((err) => {
	console.error(pc.red(err instanceof Error ? (err.stack ?? err.message) : String(err)))
	process.exit(1)
})
