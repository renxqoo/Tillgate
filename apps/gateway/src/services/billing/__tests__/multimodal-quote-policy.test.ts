import { describe, expect, it } from 'vitest';
import {
  analyzeMultimodalRequest,
  authorizeMultimodalQuote,
  MultimodalQuoteError,
  validateMultimodalPolicy,
} from '../multimodal-quote-policy.js';

const policy = {
  version: 1 as const,
  billingMode: 'unified_input_tokens' as const,
  maxInputTokens: 128_000,
  modalities: {
    image: { maxItems: 2, maxInlineBytes: 16 },
    audio: { maxItems: 1, maxInlineBytes: 16 },
    file: { maxItems: 1, maxInlineBytes: 16 },
  },
};

describe('multimodal quote policy boundary', () => {
  it('识别 HTTPS 图片和内嵌音频，并按模型硬上限授权', () => {
    const analysis = analyzeMultimodalRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
            {
              type: 'input_audio',
              input_audio: { data: 'UklGRgAAAABXQVZF', format: 'wav' },
            },
          ],
        },
      ],
    });
    expect(analysis.counts).toMatchObject({ image: 1, audio: 1, file: 0 });
    expect(analysis.inlineBytes.audio).toBe(12);
    expect(authorizeMultimodalQuote(analysis, policy)).toBe(128_000);
  });

  it('严格拒绝 HTTP URL、坏 base64、未知 part 与数量越界', () => {
    const cases = [
      { messages: [{ content: [{ type: 'image_url', image_url: { url: 'http://a/x' } }] }] },
      { messages: [{ content: [{ type: 'input_audio', input_audio: { data: '***' } }] }] },
      {
        messages: [
          { content: [{ type: 'image_url', image_url: { url: 'https://a/x', detail: 'huge' } }] },
        ],
      },
      { messages: [{ content: [{ type: 'video_url', video_url: 'https://a/x' }] }] },
      { modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' } },
    ];
    for (const body of cases)
      expect(() => analyzeMultimodalRequest(body)).toThrow(MultimodalQuoteError);

    const tooMany = analyzeMultimodalRequest({
      messages: [
        {
          content: [
            { type: 'image_url', image_url: { url: 'https://a/1' } },
            { type: 'image_url', image_url: { url: 'https://a/2' } },
            { type: 'image_url', image_url: { url: 'https://a/3' } },
          ],
        },
      ],
    });
    expect(() => authorizeMultimodalQuote(tooMany, policy)).toThrow('数量超过');
  });

  it('缺策略、坏版本、缺模态能力均 fail closed', () => {
    const image = analyzeMultimodalRequest({
      messages: [{ content: [{ type: 'image_url', image_url: { url: 'https://a/x' } }] }],
    });
    expect(() => authorizeMultimodalQuote(image, null)).toThrow('没有有效');
    expect(validateMultimodalPolicy({ ...policy, version: 2 })).toBeNull();
    expect(() =>
      authorizeMultimodalQuote(image, {
        version: 1,
        billingMode: 'unified_input_tokens',
        maxInputTokens: 100,
        modalities: { audio: { maxItems: 1 } },
      }),
    ).toThrow('不支持 image');
  });

  it('纯文本不要求多模态策略', () => {
    const analysis = analyzeMultimodalRequest({
      messages: [{ content: [{ type: 'text', text: 'hello' }] }],
    });
    expect(analysis.modalities).toEqual([]);
    expect(authorizeMultimodalQuote(analysis, null)).toBe(0);
  });
});
