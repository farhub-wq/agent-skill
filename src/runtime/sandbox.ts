import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tracer } from '../trace/tracer.js';

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxHeapMb: number;
  maxFiles: number;
  maxWriteBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  maxHeapMb: 256,
  maxFiles: 50,
  maxWriteBytes: 10_485_760,
});

export interface SandboxRequest {
  /** Command string, or argv array. `node` resolves to the current executable. */
  command: string | string[];
  cwd: string;
  allowRead?: string[];
  allowWrite?: string[];
  env?: Record<string, string>;
  stdin?: string;
  limits?: Partial<SandboxLimits>;
  allowNetwork?: boolean;
  tracer: Tracer;
}

export interface SandboxResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  egressBlocked: boolean;
  unsupported?: boolean;
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Preloaded into the sandboxed process. It is best-effort: native addons can
 * bypass module patching, which is why the docs never call this a boundary.
 * Written without template literals so it can live in this source verbatim.
 */
const GUARD_SOURCE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import net from 'node:net';",
  "import dns from 'node:dns';",
  "import cp from 'node:child_process';",
  '',
  'const raw = process.env.AGENT_SKILL_GUARD;',
  'const cfg = raw ? JSON.parse(raw) : {};',
  'function deny(code, message) {',
  '  const error = new Error(message);',
  '  error.code = code;',
  '  throw error;',
  '}',
  '',
  'const writeRoots = (cfg.writeRoots || []).map((entry) => path.resolve(entry));',
  'let fileCount = 0;',
  'let byteCount = 0;',
  'function checkPath(target) {',
  '  const resolved = path.resolve(String(target));',
  '  const inside = writeRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));',
  '  if (!inside) deny("EAGENT_SKILL_PATH", "write outside sandbox roots: " + resolved);',
  '  return resolved;',
  '}',
  'function account(size) {',
  '  fileCount += 1;',
  '  byteCount += Number(size) || 0;',
  '  if (fileCount > cfg.maxFiles) deny("EAGENT_SKILL_LIMIT", "sandbox file limit exceeded");',
  '  if (byteCount > cfg.maxWriteBytes) deny("EAGENT_SKILL_LIMIT", "sandbox write byte limit exceeded");',
  '}',
  'function sizeOf(data) {',
  '  if (typeof data === "string") return Buffer.byteLength(data);',
  '  if (data && typeof data.byteLength === "number") return data.byteLength;',
  '  return 0;',
  '}',
  'const originalWriteFileSync = fs.writeFileSync;',
  'fs.writeFileSync = function (target, data, ...rest) { checkPath(target); account(sizeOf(data)); return originalWriteFileSync.call(this, target, data, ...rest); };',
  'const originalAppendFileSync = fs.appendFileSync;',
  'fs.appendFileSync = function (target, data, ...rest) { checkPath(target); account(sizeOf(data)); return originalAppendFileSync.call(this, target, data, ...rest); };',
  'const originalOpenSync = fs.openSync;',
  'fs.openSync = function (target, flags, ...rest) { if (typeof flags === "string" && /[wa+]/.test(flags)) { checkPath(target); account(0); } return originalOpenSync.call(this, target, flags, ...rest); };',
  'const originalCreateWriteStream = fs.createWriteStream;',
  'fs.createWriteStream = function (target, ...rest) { checkPath(target); account(0); return originalCreateWriteStream.call(this, target, ...rest); };',
  'const originalPromiseWriteFile = fs.promises.writeFile;',
  'fs.promises.writeFile = async function (target, data, ...rest) { checkPath(target); account(sizeOf(data)); return originalPromiseWriteFile.call(fs.promises, target, data, ...rest); };',
  'const originalPromiseAppendFile = fs.promises.appendFile;',
  'fs.promises.appendFile = async function (target, data, ...rest) { checkPath(target); account(sizeOf(data)); return originalPromiseAppendFile.call(fs.promises, target, data, ...rest); };',
  'for (const name of ["renameSync", "copyFileSync", "cpSync"]) {',
  '  const original = fs[name];',
  '  if (typeof original !== "function") continue;',
  '  fs[name] = function (source, target, ...rest) {',
  '    if (name === "renameSync" || name === "copyFileSync") { checkPath(target); account(0); }',
  '    else { checkPath(target); account(0); }',
  '    return original.call(this, source, target, ...rest);',
  '  };',
  '}',
  '',
  'if (cfg.network !== true) {',
  '  net.Socket.prototype.connect = function () { deny("EAGENT_SKILL_EGRESS", "network egress blocked by agent-skill sandbox"); };',
  '  net.connect = function () { deny("EAGENT_SKILL_EGRESS", "network egress blocked by agent-skill sandbox"); };',
  '  net.createConnection = function () { deny("EAGENT_SKILL_EGRESS", "network egress blocked by agent-skill sandbox"); };',
  '  dns.lookup = function () { deny("EAGENT_SKILL_EGRESS", "DNS blocked by agent-skill sandbox"); };',
  '  dns.resolve = function () { deny("EAGENT_SKILL_EGRESS", "DNS blocked by agent-skill sandbox"); };',
  '  if (dns.promises) { dns.promises.lookup = function () { deny("EAGENT_SKILL_EGRESS", "DNS blocked by agent-skill sandbox"); }; }',
  '  globalThis.fetch = function () { deny("EAGENT_SKILL_EGRESS", "fetch blocked by agent-skill sandbox"); };',
  '}',
  '',
  'if (cfg.childProcess !== true) {',
  '  for (const name of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) {',
  '    cp[name] = function () { deny("EAGENT_SKILL_SUBPROCESS", "child processes blocked by agent-skill sandbox"); };',
  '  }',
  '}',
  '',
].join('\n');

const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
];

function buildEnv(extra: Record<string, string> | undefined, guardConfig: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.AGENT_SKILL_GUARD = JSON.stringify(guardConfig);
  for (const [key, value] of Object.entries(extra ?? {})) env[key] = value;
  return env;
}

function commandToArgv(command: string | string[]): string[] {
  return Array.isArray(command) ? command : tokenizeCommand(command);
}

export async function runSandboxed(request: SandboxRequest): Promise<SandboxResult> {
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...request.limits };
  const argv = commandToArgv(request.command);
  const cwd = path.resolve(request.cwd);
  const allowRead = (request.allowRead ?? [cwd]).map((entry) => path.resolve(entry));
  const allowWrite = (request.allowWrite ?? []).map((entry) => path.resolve(entry));
  const startedAt = Date.now();

  if (argv.length === 0) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: 'empty command',
      durationMs: 0,
      timedOut: false,
      outputLimitExceeded: false,
      egressBlocked: false,
      unsupported: true,
    };
  }

  const executable = argv[0] ?? '';
  if (executable !== 'node' && executable !== 'node.exe') {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: `unsupported sandbox executable: ${executable}`,
      durationMs: 0,
      timedOut: false,
      outputLimitExceeded: false,
      egressBlocked: false,
      unsupported: true,
    };
  }

  const guardDir = mkdtempSync(path.join(os.tmpdir(), 'agent-skill-guard-'));
  const guardFile = path.join(guardDir, 'guard.mjs');
  writeFileSync(guardFile, GUARD_SOURCE, 'utf8');

  const nodeArgs = [
    '--permission',
    `--allow-fs-read=${cwd}`,
    ...allowRead.map((entry) => `--allow-fs-read=${entry}`),
    // The guard itself is an ESM import and needs read access under the permission model.
    `--allow-fs-read=${guardDir}`,
    ...allowWrite.map((entry) => `--allow-fs-write=${entry}`),
    `--max-old-space-size=${limits.maxHeapMb}`,
    '--import',
    pathToFileURL(guardFile).href,
    ...argv.slice(1),
  ];

  request.tracer.emit('sandbox.start', {
    command: argv.join(' '),
    cwd,
    allowWrite,
    allowNetwork: request.allowNetwork === true,
  });

  return await new Promise<SandboxResult>((resolve) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd,
      env: buildEnv(request.env, {
        writeRoots: allowWrite,
        maxFiles: limits.maxFiles,
        maxWriteBytes: limits.maxWriteBytes,
        network: request.allowNetwork === true,
        childProcess: false,
      }),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let outputLimitExceeded = false;
    let timedOut = false;

    const finish = (exitCode: number | null): void => {
      const result: SandboxResult = {
        ok: exitCode === 0 && !timedOut && !outputLimitExceeded,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        outputLimitExceeded,
        egressBlocked: /EAGENT_SKILL_EGRESS|network egress blocked/i.test(stderr),
      };
      request.tracer.emit('sandbox.end', {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut,
        outputLimitExceeded,
      });
      if (result.egressBlocked) {
        request.tracer.emit('sandbox.egress-blocked', { command: argv.join(' ') });
      }
      try {
        rmSync(guardDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup of our own temp directory
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limits.timeoutMs);
    timer.unref?.();

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (target === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > limits.maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill('SIGKILL');
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      stderr += `\nspawn error: ${error.message}`;
      finish(null);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });

    if (request.stdin === undefined) {
      child.stdin?.end();
    } else {
      child.stdin?.end(request.stdin);
    }
  });
}
