import { describe, expect, it } from 'vitest';
import { createSupervisor, SupervisorError } from '../../src/runtime/supervisor.js';
import { createTracer } from '../../src/trace/tracer.js';

describe('supervisor restart intensity', () => {
  it('returns the first successful result without restarting', async () => {
    const tracer = createTracer();
    const supervisor = createSupervisor({ tracer });
    let calls = 0;
    const value = await supervisor.run('task', async () => {
      calls += 1;
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(calls).toBe(1);
    expect(tracer.events()).toHaveLength(0);
  });

  it('restarts with exponential backoff and traces the restart', async () => {
    const tracer = createTracer();
    const delays: number[] = [];
    const supervisor = createSupervisor({
      tracer,
      baseDelayMs: 10,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    let calls = 0;
    const value = await supervisor.run('task', async () => {
      calls += 1;
      if (calls < 2) throw new Error('crashed');
      return 'recovered';
    });

    expect(value).toBe('recovered');
    expect(calls).toBe(2);
    expect(delays).toEqual([10]);
    const event = tracer.events().find((item) => item.type === 'supervisor.restart');
    expect(event?.data.attempt).toBe(1);
  });

  it('stops once the restart budget is exhausted', async () => {
    const tracer = createTracer();
    const supervisor = createSupervisor({
      tracer,
      maxRestarts: 2,
      sleep: async () => {},
    });
    let calls = 0;
    await expect(
      supervisor.run('task', async () => {
        calls += 1;
        throw new Error('always');
      }),
    ).rejects.toThrow(SupervisorError);

    expect(calls).toBe(3);
    const events = tracer.events();
    expect(events.at(-1)?.data.action).toBe('exhausted');
    expect((events.at(-1)?.data.restarts as number)).toBe(3);
  });

  it('forgets restarts outside the window', async () => {
    const tracer = createTracer();
    const stamps = [0, 600, 1200, 1800];
    let index = 0;
    const supervisor = createSupervisor({
      tracer,
      maxRestarts: 1,
      windowMs: 500,
      sleep: async () => {},
      clock: () => stamps[Math.min(index++, stamps.length - 1)] ?? 0,
    });
    let calls = 0;
    const value = await supervisor.run('task', async () => {
      calls += 1;
      if (calls < 4) throw new Error('flaky');
      return 'steady';
    });

    expect(value).toBe('steady');
    expect(calls).toBe(4);
    expect(tracer.events().filter((event) => event.type === 'supervisor.restart')).toHaveLength(3);
  });
});
