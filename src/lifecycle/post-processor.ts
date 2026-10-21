/**
 * 技能内容后处理器：在技能加载后、激活前按顺序加工内容。
 * 处理器只接收显式上下文，不读取全局状态，便于单独测试。
 */
import type { RegisteredSkill } from '../registry/scope.js';
import type { Tracer } from '../trace/tracer.js';

export interface PostProcessorContext {
  skill: RegisteredSkill;
  content: string;
  tracer: Tracer;
}

export interface SkillPostProcessor {
  name: string;
  /** 数值越小越先执行；相同 order 按名称排序。 */
  order: number;
  /** 返回新的上下文；不得原地修改输入对象。 */
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
 * 按 order 升序执行后处理器。
 * 每个处理器前后各写一条 trace，内容长度变化用 delta 记录，
 * 这样“处理器被静默跳过”或“处理没有生效”都能从账本看出来。
 */
export async function runPostProcessors(
  context: PostProcessorContext,
  processors: readonly SkillPostProcessor[],
): Promise<PostProcessorContext> {
  const ordered = [...processors].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  let current = context;

  for (const processor of ordered) {
    // 记录处理前长度，用于计算本步的内容增量。
    const before = current.content.length;
    context.tracer.emit('skill.post-process', {
      processor: processor.name,
      order: processor.order,
      skill: context.skill.manifest.name,
    });
    try {
      current = await processor.process(current);
    } catch (error) {
      // 统一包装成带处理器名称的错误，调用方无需解析原始异常。
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
