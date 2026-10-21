import type { RegisteredSkill } from '../registry/scope.js';
import type { Tracer } from '../trace/tracer.js';

export interface PostProcessorContext {
  skill: RegisteredSkill;
  content: string;
  tracer: Tracer;
}

export interface SkillPostProcessor {
  name: string;
  order: number;
  process(context: PostProcessorContext): PostProcessorContext | Promise<PostProcessorContext>;
}

export class PostProcessorError extends Error {
  constructor(
    message: string,
    readonly processor: string,
  ) {
    super(message);
    this.name = 'PostProcessorError';
  }
}

/**
 * Post processors run in ascending order and always emit a trace event before
 * returning, so a silently skipped processor is observable.
 */
export async function runPostProcessors(
  context: PostProcessorContext,
  processors: readonly SkillPostProcessor[],
): Promise<PostProcessorContext> {
  const ordered = [...processors].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  let current = context;

  for (const processor of ordered) {
    const before = current.content.length;
    context.tracer.emit('skill.post-process', {
      processor: processor.name,
      order: processor.order,
      skill: context.skill.manifest.name,
    });
    try {
      current = await processor.process(current);
    } catch (error) {
      throw new PostProcessorError(
        `post processor ${processor.name} failed: ${(error as Error).message}`,
        processor.name,
      );
    }
    context.tracer.emit('skill.post-process', {
      processor: processor.name,
      skill: context.skill.manifest.name,
      delta: current.content.length - before,
    });
  }

  return current;
}
