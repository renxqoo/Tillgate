/**
 * 共享 tsup 预设：所有 apps/packages 的 tsup.config.ts 直接引用。
 * 仅允许类型导入（编译期擦除），保持运行时零依赖。
 */
import type { Options } from 'tsup';

export const shared: Pick<Options, 'format' | 'sourcemap' | 'clean' | 'target'> = {
  format: ['esm'],
  sourcemap: true,
  clean: true,
  target: 'node22',
};
