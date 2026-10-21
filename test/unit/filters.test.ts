import { describe, expect, it } from 'vitest';
import {
  createFilterChain,
  FilterPolicyError,
  type ToolFilter,
} from '../../src/filters/chain.js';
import { createAuditFilter } from '../../src/filters/audit.js';
import { createAuthzFilter } from '../../src/filters/authz.js';
import { createCapabilityFilter } from '../../src/filters/capability.js';
import { createDefaultFilters } from '../../src/filters/index.js';
import { createDlpFilter } from '../../src/filters/dlp.js';
import { createRateLimitFilter } from '../../src/filters/rate-limit.js';
import { createTracer } from '../../src/trace/tracer.js';
import { makeManifest, toolCall } from '../helpers.js';

const permissions = makeManifest().permissions;

function chain(filters: readonly ToolFilter[], runId = 'filter-run') {
  const tracer = createTracer({ runId });
  return { tracer, chain: createFilterChain(filters, { tracer }) };
}

describe('filter chain ordering', () => {
  it('runs before ascending and after hooks in reverse', async () => {
    const log: string[] = [];
    const makeFilter = (name: string, order: number): ToolFilter => ({
      name,
      order,
      async before(_call, next) {
        log.push(`before:${name}`);
        const result = await next();
        log.push(`after:${name}`);
        return result;
      },
    });

    const { chain: pipeline } = chain([makeFilter('a', 75), makeFilter('b', 25)]);
    const result = await pipeline.run(toolCall(), async () => {
      log.push('terminal');
      return { ok: true, value: 'done' };
    });

    expect(result.ok).toBe(true);
    expect(log).toEqual(['before:b', 'before:a', 'terminal', 'after:a', 'after:b']);
  });

  it('keeps the documented default filter order', () => {
    const { chain: pipeline } = chain([
      createAuditFilter(),
      createDlpFilter({ allowedData: [] }),
      createCapabilityFilter({ capabilities: ['fs.read'], permissions }),
      createAuthzFilter(),
      createRateLimitFilter(),
    ]);
    expect(pipeline.filterNames()).toEqual(['rate-limit', 'authz', 'capability', 'dlp', 'audit']);
    expect(
      createDefaultFilters({ capabilities: ['fs.read'], permissions }).map((filter) => filter.name),
    ).toEqual(['rate-limit', 'authz', 'capability', 'dlp', 'audit']);
  });
});

describe('short circuits and failure policy', () => {
  it('records a short circuit and skips the terminal handler', async () => {
    let terminalCalls = 0;
    const stopper: ToolFilter = {
      name: 'stopper',
      order: 10,
      async before() {
        return { ok: false, error: { code: 'STOPPED', message: 'blocked by test' } };
      },
    };
    const { tracer, chain: pipeline } = chain([stopper]);
    const result = await pipeline.run(toolCall(), async () => {
      terminalCalls += 1;
      return { ok: true };
    });

    expect(result.ok).toBe(false);
    expect(terminalCalls).toBe(0);
    const types = tracer.events().map((event) => event.type);
    expect(types).toContain('filter.shortcircuit');
    expect(types).toContain('tool.error');
  });

  it('fails closed on policy errors for read-only calls', async () => {
    const filter: ToolFilter = {
      name: 'policy',
      order: 10,
      async before() {
        throw new FilterPolicyError('DENIED', 'policy says no');
      },
    };
    const { tracer, chain: pipeline } = chain([filter]);
    const result = await pipeline.run(toolCall(), async () => ({ ok: true }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_BLOCKED');
    expect(result.meta?.failClosed).toBe(true);
    expect(result.meta?.reason).toBe('DENIED');
    const errorEvent = tracer
      .events()
      .find((event) => event.type === 'filter.error');
    expect(errorEvent?.data.action).toBe('fail-closed');
  });

  it('fails open with a degraded marker for read-only non-policy errors', async () => {
    const filter: ToolFilter = {
      name: 'flaky',
      order: 10,
      async before() {
        throw new Error('accidental bug');
      },
    };
    const { tracer, chain: pipeline } = chain([filter]);
    const result = await pipeline.run(toolCall(), async () => ({ ok: true, value: 'served' }));

    expect(result.ok).toBe(true);
    expect(result.meta?.degraded).toBe(true);
    const errorEvent = tracer.events().find((event) => event.type === 'filter.error');
    expect(errorEvent?.data.action).toBe('fail-open');
  });

  it('fails closed on non-policy errors for mutating calls', async () => {
    const filter: ToolFilter = {
      name: 'flaky',
      order: 10,
      async before() {
        throw new Error('accidental bug');
      },
    };
    const { chain: pipeline } = chain([filter]);
    const result = await pipeline.run(toolCall({ sideEffect: 'mutating' }), async () => ({
      ok: true,
    }));
    expect(result.ok).toBe(false);
    expect(result.meta?.failClosed).toBe(true);
  });
});

describe('built-in filters', () => {
  it('rate limits per caller and tool', async () => {
    const filter = createRateLimitFilter({ limit: 1, windowMs: 1000, clock: () => 1000 });
    const { chain: pipeline } = chain([filter]);
    const call = toolCall();
    expect((await pipeline.run(call, async () => ({ ok: true }))).ok).toBe(true);
    const second = await pipeline.run(call, async () => ({ ok: true }));
    expect(second.ok).toBe(false);
    expect(second.meta?.reason).toBe('RATE_LIMITED');
  });

  it('requires a caller identity and optional tool roles', async () => {
    const filter = createAuthzFilter({ requiredRoles: { Bash: ['admin'] } });
    const { chain: pipeline } = chain([filter]);

    const anonymous = await pipeline.run(toolCall({ caller: { id: ' ', roles: [] } }), async () => ({
      ok: true,
    }));
    expect(anonymous.meta?.reason).toBe('UNAUTHORIZED');

    const user = await pipeline.run(
      toolCall({ tool: 'Bash', caller: { id: 'u1', roles: ['user'] } }),
      async () => ({ ok: true }),
    );
    expect(user.meta?.reason).toBe('UNAUTHORIZED');

    const admin = await pipeline.run(
      toolCall({ tool: 'Bash', caller: { id: 'a1', roles: ['admin'] } }),
      async () => ({ ok: true, value: 'yes' }),
    );
    expect(admin.ok).toBe(true);
  });

  it('denies capabilities and permission classes the manifest did not declare', async () => {
    const filter = createCapabilityFilter({
      capabilities: ['fs.read', 'net', 'exec'],
      permissions,
    });
    const { chain: pipeline } = chain([filter]);

    const undeclared = await pipeline.run(toolCall({ tool: 'Task', capability: 'task' }), async () => ({
      ok: true,
    }));
    expect(undeclared.meta?.reason).toBe('CAPABILITY_DENIED');

    const net = await pipeline.run(
      toolCall({ tool: 'WebFetch', capability: 'net', args: { url: 'https://example.com' } }),
      async () => ({ ok: true }),
    );
    expect(net.meta?.reason).toBe('NETWORK_DENIED');

    const exec = await pipeline.run(
      toolCall({ tool: 'Bash', capability: 'exec', args: { command: 'ls' } }),
      async () => ({ ok: true }),
    );
    expect(exec.meta?.reason).toBe('EXEC_NOT_DECLARED');

    const fs = await pipeline.run(toolCall({ tool: 'Read', capability: 'fs.read' }), async () => ({
      ok: true,
    }));
    expect(fs.meta?.reason).toBe('PATH_DENIED');
  });

  it('blocks secrets and PII without echoing the matched value', async () => {
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const { chain: pipeline } = chain([createDlpFilter({ allowedData: [] })]);
    const blocked = await pipeline.run(toolCall({ args: { token: secret } }), async () => ({
      ok: true,
    }));
    expect(blocked.ok).toBe(false);
    expect(blocked.meta?.reason).toBe('DLP_SECRET_BLOCKED');
    expect(blocked.error?.message).not.toContain(secret);

    const pii = await pipeline.run(toolCall({ args: { email: 'person@example.com' } }), async () => ({
      ok: true,
    }));
    expect(pii.meta?.reason).toBe('DLP_PII_BLOCKED');

    const allowed = chain([createDlpFilter({ allowedData: ['pii'] })]);
    const permitted = await allowed.chain.run(
      toolCall({ args: { email: 'person@example.com' } }),
      async () => ({ ok: true }),
    );
    expect(permitted.ok).toBe(true);
  });

  it('emits audit records with a digest instead of raw arguments', async () => {
    const tracer = createTracer();
    const pipeline = createFilterChain([createAuditFilter({ tracer })], { tracer });
    const result = await pipeline.run(toolCall({ args: { path: 'SKILL.md' } }), async () => ({
      ok: true,
      value: 'content',
    }));

    const audit = result.meta?.audit as { argsDigest: string; outcome: string };
    expect(audit.outcome).toBe('ok');
    expect(audit.argsDigest).toMatch(/^[0-9a-f]{64}$/);
    const records = tracer.events().filter((event) => event.type === 'audit.record');
    expect(records.map((event) => event.data.phase)).toEqual(['before', 'after']);
  });
});
