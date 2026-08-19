/** 生成任务类型词表（纯数据）：执行模型 + 快照白名单。 */
import { describe, expect, it } from 'vitest';
import { generationKindDescriptor, GENERATION_KINDS } from '../kinds.js';

describe('生成任务类型词表', () => {
  it('video = task_poll（网关提交上游任务号，worker 轮询）；music = task_execute（worker 代执行）', () => {
    expect(GENERATION_KINDS.video.execution).toBe('task_poll');
    expect(GENERATION_KINDS.music.execution).toBe('task_execute');
  });

  it('video 快照白名单：prompt/duration/size/首尾帧显式收录，未知字段不落库', () => {
    const snap = GENERATION_KINDS.video.snapshotParams({
      model: 'v-model', prompt: 'a cat', duration: 6, size: '1280x720',
      image: 'data:...', last_frame_image: 'data:...',
      evil: '<script>', stream: true,
    });
    expect(snap).toEqual({
      model: 'v-model', prompt: 'a cat', duration: 6, size: '1280x720',
      image: 'data:...', last_frame_image: 'data:...',
    });
  });

  it('music 快照白名单：model/prompt/lyrics（即 worker 代执行请求体）', () => {
    const snap = GENERATION_KINDS.music.snapshotParams({ model: 'm', prompt: 'p', lyrics: 'l', n: 3 });
    expect(snap).toEqual({ model: 'm', prompt: 'p', lyrics: 'l' });
  });

  it('未知 kind 返回 undefined（消费方结构拒绝）', () => {
    expect(generationKindDescriptor('image')).toBeUndefined();
  });
});
