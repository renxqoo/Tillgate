import { describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import type { AiEvent } from '../../src/events.js';
import { startServer } from './helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';
import { defaultAiConfig } from '../../src/config.js';

/**
 * vendor profile 端到端（createAi 全链）：channel.vendor → prepare 编译 →
 * adapter.normalizeRequest 执行 → 上游收到映射后参数 + param_adjustment 事件可观测。
 */
describe('vendor profile 经 createAi 生效', () => {
  it('openai 档案：max_tokens 重命名为 max_completion_tokens（per-model 规则仍可覆盖）', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }));
      });
    });
    try {
      const events: AiEvent[] = [];
      const ai = createAi(
        { ...defaultAiConfig(), allowLocalUrl: true },
        memoryDeps(),
      );
      ai.onEvent((e) => events.push(e));

      // vendor=openai：profile 把 max_tokens 映射为 max_completion_tokens
      const result = await ai.chat({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'sk-test', protocol: 'openai-compatible', vendor: 'openai' },
        request: { model: 'ext', messages: [{ role: 'user', content: 'hi' }], max_tokens: 128 },
        ctx: { requestId: 'vp-1', model: 'real-model', providerName: 'openai', endpoint: 'chat' },
      });
      expect(result.status).toBe('success');
      expect(seen[0]).toMatchObject({ max_completion_tokens: 128 });
      expect(seen[0]).not.toHaveProperty('max_tokens');
      expect(events).toContainEqual(expect.objectContaining({
        type: 'param_adjustment', param: 'max_tokens', action: 'map',
      }));

      // per-model 规则覆盖 profile：paramRules 显式把 max_tokens 映到别的名字则 model 侧胜出
      seen.length = 0;
      await ai.chat({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'sk-test', protocol: 'openai-compatible', vendor: 'openai' },
        request: { model: 'ext', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
        ctx: {
          requestId: 'vp-2', model: 'real-model', providerName: 'openai', endpoint: 'chat',
          paramRules: { map: { max_tokens: { to: 'model_max' } } },
        },
      });
      expect(seen[0]).toMatchObject({ model_max: 64 });
      expect(seen[0]).not.toHaveProperty('max_completion_tokens');
    } finally {
      await upstream.close();
    }
  });
});
