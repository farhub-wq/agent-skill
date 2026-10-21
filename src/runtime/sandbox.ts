/**
 * 子进程沙箱：用 node --permission 限制文件系统，用预加载 guard 拦截网络、
 * 子进程与越界写入，并施加超时/内存/输出/文件数限制。
 * 注意：这是尽力而为的降级手段，不是安全边界（原生模块可绕过模块补丁）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tracer } from '../trace/tracer.js';

/** 沙箱资源限制。 */
export interface SandboxLimits {
  /** 执行超时，超时后 SIGKILL。 */
  timeoutMs: number;
  /** stdout+stderr 合计字节上限。 */
  maxOutputBytes: number;
  /** V8 堆上限（MB）。 */
  maxHeapMb: number;
  /** 运行期间最多写入的文件数。 */
  maxFiles: number;
  /** 运行期间最多写入的字节数。 */
  maxWriteBytes: number;
}

/** 默认限制：30s / 1MB 输出 / 256MB 堆 / 50 文件 / 10MB 写入。 */
export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  maxHeapMb: 256,
  maxFiles: 50,
  maxWriteBytes: 10_485_760,
});

export interface SandboxRequest {
  /** 命令字符串或 argv 数组；node 会被解析为当前可执行文件。 */
  command: string | string[];
  /** 工作目录，同时作为默认读权限根。 */
  cwd: string;
  /** 额外的可读目录，默认只允许 cwd。 */
  allowRead?: string[];
  /** 可写目录，默认不允许任何写入。 */
  allowWrite?: string[];
  /** 追加给子进程的环境变量（会叠加在裸名白名单之上）。 */
  env?: Record<string, string>;
  /** 写入子进程 stdin 的内容；不传则立即关闭。 */
  stdin?: string;
  /** 覆盖默认资源限制。 */
  limits?: Partial<SandboxLimits>;
  /** 是否允许网络，默认 false。 */
  allowNetwork?: boolean;
  /** 用于记录沙箱开始/结束/外连事件。 */
  tracer: Tracer;
}

/** 沙箱执行结果。 */
export interface SandboxResult {
  /** 退出码为 0 且未超时、未超输出限制。 */
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  /** stderr 中出现 guard 的外连拦截标记。 */
  egressBlocked: boolean;
  /** 命令为空或不是 node 时置位。 */
  unsupported?: boolean;
}

/**
 * 将命令字符串拆成 argv，支持单引号/双引号与反斜杠转义；
 * 不调用 shell，避免引入 shell 注入面。
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    // 引号内部：只在同种引号处结束，反斜杠转义下一个字符。
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
 * 预加载进沙箱子进程的 guard 源码，分四部分：
 * 1. 路径检查与写入配额（文件数/字节数）；
 * 2. 包装 fs 的写文件 API，拒绝越界写入；
 * 3. 未开启网络时封禁 net/dns/fetch；
 * 4. 默认封禁 child_process。
 * 仅尽力而为：原生模块可绕过模块补丁，因此文档从不称其为安全边界。
 * 用字符串数组拼接，避免模板字符串转义问题。
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

/** 传给子进程的环境变量白名单，避免泄漏宿主的密钥类变量。 */
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

/** 构造子进程环境：白名单变量 + guard 配置 + 调用方显式追加项。 */
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

/** 统一命令输入：数组直接使用，字符串走 tokenizer。 */
function commandToArgv(command: string | string[]): string[] {
  return Array.isArray(command) ? command : tokenizeCommand(command);
}

/**
 * 在受限子进程中执行命令。
 * 步骤：合并限制 → 解析 argv/路径 → 写 guard → 组装 node 参数 → spawn →
 * 监控超时/输出 → 清理 guard 临时目录 → 返回结构化结果。
 */
export async function runSandboxed(request: SandboxRequest): Promise<SandboxResult> {
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...request.limits };
  const argv = commandToArgv(request.command);
  const cwd = path.resolve(request.cwd);
  const allowRead = (request.allowRead ?? [cwd]).map((entry) => path.resolve(entry));
  const allowWrite = (request.allowWrite ?? []).map((entry) => path.resolve(entry));
  const startedAt = Date.now();

  // 空命令直接返回 unsupported，不启动进程。
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

  // 只支持 node：其他解释器无法可靠套用 node 权限模型。
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

  // guard 需要单独目录并在 --permission 下显式授予读权限。
  const guardDir = mkdtempSync(path.join(os.tmpdir(), 'agent-skill-guard-'));
  const guardFile = path.join(guardDir, 'guard.mjs');
  writeFileSync(guardFile, GUARD_SOURCE, 'utf8');

  const nodeArgs = [
    '--permission',
    `--allow-fs-read=${cwd}`,
    ...allowRead.map((entry) => `--allow-fs-read=${entry}`),
    // guard 本身是 ESM import，在权限模型下必须显式授予读权限。
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

  // 用 Promise 包装 spawn 事件，统一在各退出路径归还结果。
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

    // 统一收尾：判定成功、记录事件、清理临时目录、resolve。
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

    // 超时强制终止；unref 避免定时器拖住宿主进程退出。
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limits.timeoutMs);
    timer.unref?.();

    // 累计输出，超过总字节上限立即终止子进程。
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

    // 不提供 stdin 时立即关闭，防止子进程等待输入卡死。
    if (request.stdin === undefined) {
      child.stdin?.end();
    } else {
      child.stdin?.end(request.stdin);
    }
  });
}
