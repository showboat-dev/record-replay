import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

import pc from 'picocolors'

import { loadFlow, type Flow, type Step } from '@rr/schema'

const USAGE = `
${pc.bold('rr')} — 网页操作录制回放引擎（record & replay）

${pc.bold('用法')}
  rr record  --url <url> --out flows/<id>.json [--viewport 1440x900] [--headless] [--keep-raw]
  rr play    flows/<id>.json [--runs 3] [--headed] [--ai] [--artifacts ./artifacts] [--json]
  rr inspect flows/<id>.json
  rr harness [--runs 10] [--sites local|all] [--out artifacts/harness] [--ai]

${pc.bold('状态')}
  M0：record / play 仍是桩（packages 正在并行实现）；inspect 已可用。

${pc.bold('退出码')}  0 成功 / 1 运行失败 / 2 用法错误
`

function usageError(msg: string): never {
	console.error(pc.red(`用法错误：${msg}`))
	console.error(USAGE)
	process.exit(2)
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
		default:
			usageError(`未知命令 "${command}"`)
	}
}

async function inspect(args: string[]): Promise<void> {
	const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
	const file = positionals[0]
	if (!file) usageError('inspect 需要一个 flow 文件路径')
	const flow = await loadFlow(resolve(file))
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

async function recordCmd(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			url: { type: 'string' },
			out: { type: 'string' },
			viewport: { type: 'string' },
			headless: { type: 'boolean', default: false },
			'keep-raw': { type: 'boolean', default: false },
			artifacts: { type: 'string' },
		},
	})
	const url = values['url']
	const out = values['out']
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
			...(values['artifacts'] ? { artifactsRoot: values['artifacts'] } : {}),
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
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			runs: { type: 'string', default: '1' },
			headed: { type: 'boolean', default: false },
			ai: { type: 'boolean', default: false },
			artifacts: { type: 'string' },
			json: { type: 'boolean', default: false },
		},
	})
	const file = positionals[0]
	if (!file) usageError('play 需要一个 flow 文件路径')
	try {
		const { playRuns } = (await import('@rr/executor')) as typeof import('@rr/executor')
		const flow = await loadFlow(resolve(file))
		const results = await playRuns({
			flow,
			headless: !values['headed'],
			runs: Number(values['runs'] ?? 1),
			...(values['artifacts'] ? { artifactsRoot: values['artifacts'] } : {}),
		})
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

async function harnessCmd(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			runs: { type: 'string', default: '1' },
			sites: { type: 'string', default: 'local' },
			out: { type: 'string' },
			ai: { type: 'boolean', default: false },
		},
	})
	try {
		const { runHarness, writeHtmlReport } =
			(await import('@rr/harness')) as typeof import('@rr/harness')
		const report = await runHarness({
			sites: [],
			runs: Number(values['runs'] ?? 1),
			...({} as Record<string, never>),
		})
		if (values['out']) await writeHtmlReport(report, `${values['out']}/report.html`)
		console.log(JSON.stringify(report, null, 2))
	} catch (err) {
		if (isMissingModule(err, '@rr/harness')) notImplemented('harness')
		throw err
	}
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
