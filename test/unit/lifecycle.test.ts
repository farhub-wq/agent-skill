/**
 * 生命周期单元测试：状态机合法/非法转换，以及后处理器的顺序与错误包装。
 */
import { describe, expect, it } from 'vitest';
import {
  runPostProcessors,
  PostProcessorError,
  type SkillPostProcessor,
} from '../../src/lifecycle/post-processor.js';
import { createLifecycle, LifecycleError } from '../../src/lifecycle/skill.js';
import { createTracer } from '../../src/trace/tracer.js';
import { registeredSkill } from '../helpers.js';

describe('lifecycle state machine', () => {
  it('walks discovered -> admitted -> loaded -> active -> disposed', async () => {
    const tracer = createTracer();
    const lifecycle = createLifecycle({ skill: 'demo-skill', tracer });
    expect(lifecycle.state()).toBe('discovered');
    await lifecycle.transition('admitted');
    await lifecycle.transition('loaded');
    await lifecycle.transition('active');
    await lifecycle.transition('disposed');
    expect(lifecycle.state()).toBe('disposed');

    const transitions = tracer
      .events()
      .filter((event) => event.type === 'lifecycle.transition')
      .map((event) => `${String(event.data.from)}->${String(event.data.to)}`);
    expect(transitions).toEqual([
      'discovered->admitted',
      'admitted->loaded',
      'loaded->active',
      'active->disposed',
    ]);
  });

  it('rejects illegal transitions and stays in the current state', async () => {
    const lifecycle = createLifecycle({ skill: 'demo-skill', tracer: createTracer() });
    await expect(lifecycle.transition('active')).rejects.toThrow(LifecycleError);
    expect(lifecycle.state()).toBe('discovered');
    await lifecycle.transition('disposed');
    await expect(lifecycle.transition('admitted')).rejects.toThrow(/invalid lifecycle transition/);
  });

  it('runs hooks in order on every transition', async () => {
    const log: string[] = [];
    const lifecycle = createLifecycle(
      { skill: 'demo-skill', tracer: createTracer() },
      [
        { name: 'second', order: 20, onEnter: () => void log.push('second') },
        { name: 'first', order: 10, onEnter: () => void log.push('first') },
      ],
    );
    await lifecycle.transition('admitted');
    expect(log).toEqual(['first', 'second']);
  });
});

describe('post processors', () => {
  it('runs in order and traces each processor', async () => {
    const tracer = createTracer();
    const processors: SkillPostProcessor[] = [
      {
        name: 'append-b',
        order: 20,
        process: (context) => ({ ...context, content: `${context.content} b` }),
      },
      {
        name: 'append-a',
        order: 10,
        process: (context) => ({ ...context, content: `${context.content} a` }),
      },
    ];
    const result = await runPostProcessors(
      { skill: registeredSkill(), content: 'start', tracer },
      processors,
    );

    expect(result.content).toBe('start a b');
    const events = tracer.events().filter((event) => event.type === 'skill.post-process');
    expect(events.map((event) => event.data.processor)).toEqual([
      'append-a',
      'append-a',
      'append-b',
      'append-b',
    ]);
  });

  it('wraps processor failures with the processor name', async () => {
    const processor: SkillPostProcessor = {
      name: 'broken',
      order: 10,
      process() {
        throw new Error('boom');
      },
    };
    await expect(
      runPostProcessors(
        { skill: registeredSkill(), content: 'x', tracer: createTracer() },
        [processor],
      ),
    ).rejects.toThrow(PostProcessorError);
  });
});
