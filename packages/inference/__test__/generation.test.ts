import { describe, expect, it } from 'vitest';
import {
  GENERATION_KINDS,
  generationKindDescriptor,
  isGenerationTaskKind,
} from '../src/domain/generation';

describe('domain/generation：任务种类注册表（词表封闭性）', () => {
  it('video = task_poll（网关提交上游任务号）；music = task_execute（登记，worker 代执行）', () => {
    expect(GENERATION_KINDS.video).toMatchObject({ kind: 'video', execution: 'task_poll' });
    expect(GENERATION_KINDS.music).toMatchObject({ kind: 'music', execution: 'task_execute' });
  });

  it('词表守卫：注册表驱动，无字面量复制', () => {
    expect(isGenerationTaskKind('video')).toBe(true);
    expect(isGenerationTaskKind('music')).toBe(true);
    expect(isGenerationTaskKind('image')).toBe(false);
    expect(generationKindDescriptor('nope')).toBeUndefined();
  });

  it('snapshotParams 白名单：只落显式字段（透传全量落库有体积与注入面风险）', () => {
    const video = GENERATION_KINDS.video.snapshotParams({
      model: 'v-model',
      prompt: 'p',
      duration: 6,
      size: '720p',
      image: 'data:...',
      last_frame_image: 'data:...',
      extra_injected: 'drop-me',
    });
    expect(video).toEqual({
      model: 'v-model',
      prompt: 'p',
      duration: 6,
      size: '720p',
      image: 'data:...',
      last_frame_image: 'data:...',
    });
    // 可选字段缺省不落键
    expect(Object.keys(GENERATION_KINDS.video.snapshotParams({ model: 'm' }))).toEqual([
      'model',
      'prompt',
    ]);
  });

  it('music 快照含 lyrics 白名单字段', () => {
    expect(
      GENERATION_KINDS.music.snapshotParams({ model: 'm', prompt: 'p', lyrics: '[verse]', x: 1 }),
    ).toEqual({ model: 'm', prompt: 'p', lyrics: '[verse]' });
  });
});
