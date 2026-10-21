#!/usr/bin/env node
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

function parseDir(positionals: string[], fallback?: string): string | undefined {
  return positionals[1] ?? fallback;
}

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
    console.error((error as Error).message);
    console.error(HELP);
    return EXIT.usage;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help === true || command === undefined) {
    console.log(HELP);
    return command === undefined && values.help !== true ? EXIT.usage : EXIT.ok;
  }

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
