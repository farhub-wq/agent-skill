/**
 * 准入单元测试：示例技能放行、恶意夹具拦截、失败码与 trace 事件。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdmissionDeniedError,
  assertAdmitted,
  runAdmission,
} from '../../src/admission/gate.js';
import { runG1 } from '../../src/admission/g1-static.js';
import { runG2 } from '../../src/admission/g2-semantic.js';
import { runG4 } from '../../src/admission/g4-manifest.js';
import { loadSkillSource, parseSkillMarkdown, type SkillSource } from '../../src/manifest/parse.js';
import { createTracer } from '../../src/trace/tracer.js';
import { exampleDir, fixtureDir, makeManifest } from '../helpers.js';

describe('admission on the example skill', () => {
  it('passes install mode with G1 and G2', async () => {
    const report = await runAdmission(await loadSkillSource(exampleDir), { gate: 'install' });
    expect(report.verdict).toBe('allow');
    expect(report.trustTier).toBe('T4');
    expect(report.gates.map((gate) => gate.gate)).toEqual(['G1', 'G2']);
    expect(report.gates.every((gate) => gate.status === 'pass')).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.advisories).toEqual([]);
  });

  it('passes full mode including the sandbox trial and permission audit', async () => {
    const report = await runAdmission(await loadSkillSource(exampleDir), { gate: 'full' });
    expect(report.verdict).toBe('allow');
    expect(report.gates.map((gate) => gate.gate)).toEqual(['G1', 'G2', 'G3', 'G4']);
    expect(report.gates.every((gate) => gate.status === 'pass')).toBe(true);
  });

  it('emits admission events with the gate verdict', async () => {
    const tracer = createTracer({ runId: 'admission-run' });
    const report = await runAdmission(await loadSkillSource(exampleDir), { tracer });
    const types = report.trace.map((event) => event.type);
    expect(types[0]).toBe('admission.start');
    expect(types).toContain('admission.gate');
    expect(types.at(-1)).toBe('admission.verdict');
    expect(tracer.events().length).toBe(report.trace.length);
  });
});

describe('adversarial fixtures are rejected before installation', () => {
  const cases: Array<[string, string]> = [
    ['preprocessing-command', 'preprocessing-command'],
    ['undeclared-tool', 'undeclared-tool'],
    ['unlisted-script', 'unlisted-script'],
    ['path-escape', 'path-escape'],
    ['network-egress', 'network-egress'],
  ];

  for (const [fixture, code] of cases) {
    it(`rejects ${fixture} with ${code}`, async () => {
      const report = await runAdmission(await loadSkillSource(fixtureDir('malicious', fixture)), {
        gate: 'install',
      });
      expect(report.verdict).toBe('deny');
      const matched = report.findings.filter((item) => item.code === code);
      expect(matched.length).toBeGreaterThan(0);
      expect(matched.every((item) => item.severity === 'error')).toBe(true);
      expect(() => assertAdmitted(report)).toThrow(AdmissionDeniedError);
    });
  }

  it('flags the preprocessing command line and its literal evidence', async () => {
    const report = await runAdmission(
      await loadSkillSource(fixtureDir('malicious', 'preprocessing-command')),
      { gate: 'install' },
    );
    const finding = report.findings.find((item) => item.code === 'preprocessing-command');
    expect(finding?.message).toMatch(/line 8/);
    expect(finding?.evidence).toContain('curl -s https://ingest.example.net');
  });

  it('sorts error findings deterministically', async () => {
    const report = await runAdmission(
      await loadSkillSource(fixtureDir('malicious', 'preprocessing-command')),
      { gate: 'install' },
    );
    const codes = report.findings.map((item) => item.code);
    expect(codes).toEqual([...codes].sort((left, right) => left.localeCompare(right)));
  });
});

describe('trust tier reconciliation', () => {
  it('denies a community skill that declares script execution at full gate', async () => {
    const report = await runAdmission(await loadSkillSource(fixtureDir('community-exec')), {
      gate: 'full',
    });
    expect(report.verdict).toBe('deny');
    expect(report.trustTier).toBe('T1');
    expect(report.findings.some((item) => item.code === 'undeclared-tool')).toBe(true);
    const g4 = report.gates.find((gate) => gate.gate === 'G4');
    expect(g4?.status).toBe('fail');
  });

  it('allows community execution declarations at install gate, leaving runtime to deny', async () => {
    const report = await runAdmission(await loadSkillSource(fixtureDir('community-exec')), {
      gate: 'install',
    });
    expect(report.verdict).toBe('allow');
  });
});

describe('gate internals', () => {
  function customSource(body: string, description: string): SkillSource {
    return {
      dir: exampleDir,
      skillMd: parseSkillMarkdown(`---\nname: demo\ndescription: ${description}\n---\n\n${body}`),
      manifest: makeManifest({ capabilities: ['fs.read'] }),
      manifestRaw: 'name: demo\n',
      scripts: [],
    };
  }

  it('G2 adds advisories without blocking', () => {
    const result = runG2(customSource('Write a report to disk.', 'Handles invoices.'));
    expect(result.findings.some((item) => item.code === 'undeclared-tool')).toBe(true);
    expect(result.advisories.map((item) => item.id)).toContain('description-trigger');
  });

  it('G1 reports undeclared tool families from allowed-tools', () => {
    const source = customSource('Read the file.', 'Use when reading.');
    source.skillMd.frontmatter['allowed-tools'] = 'Bash(cat:*)';
    const findings = runG1(source);
    expect(findings.some((item) => item.code === 'undeclared-tool')).toBe(true);
  });

  it('G1 treats absolute and parent filesystem roots as escapes', () => {
    const source = customSource('Read the file.', 'Use when reading.');
    source.manifest = makeManifest({
      permissions: { fs: ['../shared', path.resolve(exampleDir, '..')] },
    });
    const findings = runG1(source);
    expect(findings.filter((item) => item.code === 'path-escape')).toHaveLength(2);
  });

  it('G1 warns on unbounded dependency ranges', () => {
    const source = customSource('Read the file.', 'Use when reading.');
    source.manifest = makeManifest({ requires: { other: '*' } });
    const findings = runG1(source);
    const warning = findings.find((item) => item.code === 'dependency-risk');
    expect(warning?.severity).toBe('warning');
  });

  it('G4 rejects secrets below T4 and denies execution below T3', () => {
    const source = customSource('Read the file.', 'Use when reading.');
    source.manifest = makeManifest({
      trust: 'reviewed',
      capabilities: ['fs.read', 'exec'],
      permissions: { exec: ['node scripts/task.mjs'], data: ['secrets'] },
    });
    const result = runG4(source);
    const codes = result.findings.map((item) => item.code);
    expect(codes).toContain('undeclared-tool');
    expect(result.findings.some((item) => item.message.includes('secrets'))).toBe(true);
  });
});
