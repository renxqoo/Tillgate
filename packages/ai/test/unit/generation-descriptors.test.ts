import { describe, expect, it } from 'vitest';
import { GENERATION_KINDS, generationKindDescriptor, isTaskKind } from '../../src/generation/descriptors.js';

/**
 * 生成类型描述符注册表契约（units 单一真相）：
 * 上界公式与重构前逐字等价（行为特征护栏）——video+second 的 duration 钳制
 * （new-api #5498 教训）与 n 倍数规则是资金口径，改坏即红。
 */
describe('生成类型描述符注册表', () => {
  it('词表覆盖全部生成类型（任务族 + 同步模态族），无缺项', () => {
    const kinds = Object.keys(GENERATION_KINDS).toSorted();
    expect(kinds).toEqual(
      [
        'audio_speech',
        'audio_transcription',
        'audio_translation',
        'images',
        'images_edits',
        'moderations',
        'music',
        'rerank',
        'video',
      ].toSorted(),
    );
  });

  it('执行模型：video=task_poll、music=task_execute、模态族=sync', () => {
    expect(GENERATION_KINDS.video.execution).toBe('task_poll');
    expect(GENERATION_KINDS.music.execution).toBe('task_execute');
    expect(GENERATION_KINDS.images.execution).toBe('sync');
    expect(GENERATION_KINDS.audio_speech.execution).toBe('sync');
  });

  it('video 按秒：duration 钳制 4-15、缺省 6（预扣上界=结算快照同一实现）', () => {
    const d = GENERATION_KINDS.video;
    expect(d.unitsUpperBoundOf({ duration: 99 }, 'second')).toBe(15);
    expect(d.unitsUpperBoundOf({ duration: 1 }, 'second')).toBe(4);
    expect(d.unitsUpperBoundOf({ duration: 8.4 }, 'second')).toBe(8);
    expect(d.unitsUpperBoundOf({}, 'second')).toBe(6);
    expect(d.unitsOf({}, undefined)).toBe(6);
  });

  it('video 按次 → n 规则（缺省 1）；music/模态族 → n 规则', () => {
    expect(GENERATION_KINDS.video.unitsUpperBoundOf({ duration: 8 }, 'request')).toBe(1);
    expect(GENERATION_KINDS.video.unitsUpperBoundOf({ n: 3 }, 'request')).toBe(3);
    expect(GENERATION_KINDS.music.unitsUpperBoundOf({}, 'request')).toBe(1);
    expect(GENERATION_KINDS.images.unitsUpperBoundOf({ n: 4 }, 'image')).toBe(4);
    expect(GENERATION_KINDS.rerank.unitsUpperBoundOf({}, 'request')).toBe(1);
  });

  it('模态族结算实值：images 响应张数优先 / speech 字符 / STT 秒数', () => {
    expect(GENERATION_KINDS.images.unitsOf({ n: 2 }, { data: [{}] })).toBe(1);
    expect(GENERATION_KINDS.images.unitsOf({ n: 2 }, { data: [{}, {}] })).toBe(2);
    expect(GENERATION_KINDS.images.unitsOf({ n: 2 }, undefined)).toBe(2);
    expect(GENERATION_KINDS.images.unitsOf({}, undefined)).toBe(1);
    expect(GENERATION_KINDS.audio_speech.unitsOf({ input: 'héllo' }, undefined)).toBe(5);
    expect(GENERATION_KINDS.audio_transcription.unitsOf({ audioSeconds: 3.2 }, undefined)).toBe(4);
    expect(GENERATION_KINDS.rerank.unitsOf({}, undefined)).toBe(1);
  });

  it('任务族快照白名单：video 含 duration/size/帧图；music 含 lyrics', () => {
    const v = GENERATION_KINDS.video.snapshotParams!({
      model: 'm', prompt: 'p', duration: 6, size: '1280x720', image: 'data:x', junk: 'x',
    });
    expect(v).toEqual({ model: 'm', prompt: 'p', duration: 6, size: '1280x720', image: 'data:x' });
    const m = GENERATION_KINDS.music.snapshotParams!({ model: 'm', prompt: 'p', lyrics: '[v]', junk: 1 });
    expect(m).toEqual({ model: 'm', prompt: 'p', lyrics: '[v]' });
  });

  it('isTaskKind：任务族 true、sync/chat false；未知 kind 无描述符', () => {
    expect(isTaskKind('video')).toBe(true);
    expect(isTaskKind('music')).toBe(true);
    expect(isTaskKind('images')).toBe(false);
    expect(isTaskKind('chat')).toBe(false);
    expect(generationKindDescriptor('nonexistent')).toBeUndefined();
  });
});
