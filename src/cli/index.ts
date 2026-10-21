#!/usr/bin/env node
/**
 * CLI 入口：解析子命令与参数，分发给 src/cli/commands 下的实现。
 * 帮助信息以三个价值陈述开头，与 README 保持一致。
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { GateMode } from '../admission/gate.js';
import { VALUE_STATEMENTS } from '../version.js';
import { adapterCommand } from './commands/adapter.js';
import { evalCommand } from './commands/eval.js';
import { initCommand } from './commands/init.js';
import { inspectCommand } from './commands/inspect.js';
import { runCommand } from './commands/run.js';
import { verifyCommand } from './commands/verify.js';
import { EXIT } from './shared.js';

const HELP = `${VALUE_STATEMENTS[0]}
${VALUE_STATEMENTS[1]}
${VALUE_STATEMENTS[2]}

Usage: agent-skill <command> [options]

Commands:
  init [dir]                     create a skill skeleton
  verify <dir> [--gate install|full] [--json]
                                 admission check; exit 2 on deny
  inspect <dir> [--json]         show manifest, trust tier and permission ceiling
  run <dir> [--input file] [--json]
                                 run declared commands in the standalone runtime
  eval <dir> [--k 5] [--now ISO] [--json]
                                 run eval cases and write evidence.json + evidence.lock
  adapter claude [--dir <dir> --hook]
                                 print Claude hooks config, or evaluate one hook payload

Sandbox is process-level and is not a security boundary.
`;

/** 取第二个位置参数作为技能目录，未提供时使用 fallback。 */
function parseDir(positionals: string[], fallback?: string): string | undefined {
  return positionals[1] ?? fallback;
}

/** CLI 主函数：返回退出码而不直接退出，便于测试与嵌入。 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        gate: { type: 'string' },
        json: { type: 'boolean' },
        k: { type: 'string' },
        input: { type: 'string' },
        now: { type: 'string' },
        hook: { type: 'boolean' },
        dir: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    // 参数解析失败：打印原因与帮助，返回用法错误码。
    console.error((error as Error).message);
    console.error(HELP);
    return EXIT.usage;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  // 显式 --help 返回 0；完全没给命令则打印帮助并返回用法错误。
  if (values.help === true || command === undefined) {
    console.log(HELP);
    return command === undefined && values.help !== true ? EXIT.usage : EXIT.ok;
  }

  // 每个子命令自行校验必填参数，并返回约定的退出码。
  switch (command) {
    case 'init':
      return initCommand(parseDir(positionals, '.') as string);

    case 'verify': {
      const dir = parseDir(positionals);
      if (dir === undefined) {
        console.error('verify requires <dir>');
        return EXIT.usage;
      }
      const gate = (values.gate ?? 'install') as GateMode;
      if (gate !== 'install' && gate !== 'full') {
        console.error(`invalid --gate value: ${String(values.gate)}`);
        return EXIT.usage;
      }
      return verifyCommand({ dir, gate, json: values.json === true });
    }

    case 'inspect': {
      const dir = parseDir(positionals);
      if (dir === undefined) {
        console.error('inspect requires <dir>');
        return EXIT.usage;
      }
      return inspectCommand({ dir, json: values.json === true });
    }

    case 'run': {
      const dir = parseDir(positionals);
      if (dir === undefined) {
        console.error('run requires <dir>');
        return EXIT.usage;
      }
      return runCommand({
        dir,
        json: values.json === true,
        ...(values.input === undefined ? {} : { input: values.input }),
      });
    }

    case 'eval': {
      const dir = parseDir(positionals);
      if (dir === undefined) {
        console.error('eval requires <dir>');
        return EXIT.usage;
      }
      const k = values.k === undefined ? 5 : Number.parseInt(values.k, 10);
      if (!Number.isInteger(k) || k < 1) {
        console.error(`invalid --k value: ${String(values.k)}`);
        return EXIT.usage;
      }
      return evalCommand({
        dir,
        k,
        json: values.json === true,
        ...(values.now === undefined ? {} : { now: values.now }),
      });
    }

    case 'adapter': {
      if (positionals[1] !== 'claude') {
        console.error('only the claude adapter is available');
        return EXIT.usage;
      }
      const dir = values.dir;
      return adapterCommand({
        hook: values.hook === true,
        ...(dir === undefined ? {} : { dir }),
      });
    }

    default:
      console.error(`unknown command: ${command}`);
      console.error(HELP);
      return EXIT.usage;
  }
}

// 仅在作为可执行脚本运行时启动；被测试 import 时不自动执行。
const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = EXIT.usage;
    });
}
