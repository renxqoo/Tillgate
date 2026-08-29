import { describe, expect, it } from 'vitest';
import * as barrel from '../src/index';
import { createInference } from '../src/inference';
import { defaultInferenceDefaults, inferenceDefaultsSchema } from '../src/config';
import {
  baseAuth,
  channel,
  fakeAi,
  fakeBilling,
  fakeCatalog,
  fakeUpstream,
  mapping,
} from './harness';

describe('api：facade 契约与出口面', () => {
  it('出口快照（barrel 只暴露有意维护的公共接口——漂移即测试红）', () => {
    expect(Object.keys(barrel).toSorted()).toEqual([
      'ESTIMATE_ATTRIBUTIONS',
      'GENERATION_KINDS',
      'GENERATION_TASK_KINDS',
      'GENERATION_TASK_STATUSES',
      'InferenceErrors',
      'USER_SIDE_CANCELS',
      'admissionTokenUpperBound',
      'buildCandidateChain',
      'canonicalStreamToClaudeStream',
      'canonicalStreamToCompletionsStream',
      'canonicalStreamToGeminiStream',
      'canonicalStreamToResponsesStream',
      'channelHealthKey',
      'chatResponseToClaude',
      'chatResponseToCompletions',
      'chatResponseToGemini',
      'chatResponseToResponses',
      'claudeRequestToChat',
      'completionsRequestToChat',
      'conservativeInputTokenUpperBound',
      'createChannelHealth',
      'createGenerationPollUseCase',
      'createInference',
      'createMemoryGenerationTaskStore',
      'createMemoryHealthStore',
      'createMemoryStickyStore',
      'createPostgresGenerationTaskStore',
      'createRedisHealthStore',
      'createUpstreamAi',
      'defaultInferenceDefaults',
      'defaultRoutingPolicy',
      'estimateAudioDurationSeconds',
      'geminiRequestToChat',
      'inferenceDefaultsSchema',
      'isAttributedEstimate',
      'isGenerationTaskKind',
      'responsesRequestToChat',
      'routingPolicySchema',
      'staticRoutingPolicy',
      'streamEstimateAttribution',
    ]);
  });

  it('错误目录：码带包名命名空间、message 英文、zh 必填（§11 / 铁律 18）', () => {
    const catalog = barrel.InferenceErrors;
    for (const code of catalog.codes) {
      const def = catalog.get(code);
      expect(def?.message).toMatch(/^[\x20-\x7e]+$/); // 英文可打印字符
      expect(def?.zh.length).toBeGreaterThan(0);
    }
    expect(catalog.code('no_available_channel')).toBe('inference.no_available_channel');
    expect(catalog.has('inference.upstream_failed')).toBe(true);
    expect(catalog.has('inference.nope')).toBe(false);
  });

  it('缺省词表：装配可分组覆写（DESIGN §4 单一真相）', () => {
    const defaults = defaultInferenceDefaults();
    expect(defaults.breaker).toEqual({
      windowMs: 60_000,
      failureThreshold: 5,
      cooldownMs: 300_000,
      halfOpenProbe: true,
    });
    expect(defaults.deadCredential).toEqual({ failureThreshold: 3, windowMs: 3_600_000 });
    expect(defaults.authorization.ttlMs).toBe(300_000);
    const overridden = inferenceDefaultsSchema.parse({
      breaker: { failureThreshold: 9 },
      settleSignal: { attempts: 2 },
    });
    expect(overridden.breaker.failureThreshold).toBe(9);
    expect(overridden.breaker.cooldownMs).toBe(300_000); // 组内其余回落缺省
    expect(overridden.settleSignal.attempts).toBe(2);
    expect(overridden.estimate.cjkTokensPerChar).toBe(0.7); // 未涉组不受影响
  });

  it('createInference：shape 契约（chat/stream/generation/health/close）', async () => {
    const ai = fakeAi();
    const upstream = fakeUpstream();
    upstream.onChat(async () => ({ ok: true, durationMs: 1, body: {} }));
    const inference = createInference({
      ai: ai.ai,
      catalog: fakeCatalog({ 'gpt-x': mapping() }, { 'gpt-x-real': [channel()] }),
      billing: fakeBilling().port,
      store: barrel.createMemoryHealthStore(),
      decrypt: (enc) => enc,
      upstream: upstream.port,
    });
    expect(typeof inference.chat).toBe('function');
    expect(typeof inference.stream).toBe('function');
    expect(typeof inference.generation.submit).toBe('function');
    expect(typeof inference.generation.query).toBe('function');
    expect(typeof inference.generation.adminList).toBe('function');
    expect(typeof inference.generation.settledAmounts).toBe('function');
    expect(typeof inference.health.admit).toBe('function');
    expect(typeof inference.close).toBe('function');
    const delivered = await inference.chat({
      requestId: 'r',
      auth: baseAuth,
      body: { model: 'gpt-x' },
    });
    expect(delivered).toMatchObject({ ok: true, status: 200 });
    inference.close();
    // close 后 ai 事件不再被健康面消费（退订生效——不抛即可）
    ai.emit({ type: 'success', requestId: 'x', channelKey: 'k', durationMs: 1 });
  });

  it('generation 提交默认内存任务存储（单副本开发形态，装配可替换 postgres）', async () => {
    const ai = fakeAi();
    const upstream = fakeUpstream();
    upstream.onSubmit(async () => ({ ok: true, upstreamTaskId: 'up' }));
    const inference = createInference({
      ai: ai.ai,
      catalog: fakeCatalog(
        { vid: mapping({ externalModel: 'vid', realModel: 'vid-real' }) },
        { 'vid-real': [channel()] },
      ),
      billing: fakeBilling().port,
      store: barrel.createMemoryHealthStore(),
      decrypt: (enc) => enc,
      upstream: upstream.port,
    });
    const outcome = await inference.generation.submit({
      auth: baseAuth,
      kind: 'video',
      body: { model: 'vid' },
    });
    expect(outcome.ok).toBe(true);
    if ('taskId' in outcome) {
      const view = await inference.generation.query(baseAuth.userId, outcome.taskId);
      expect(view.status).toBe('queued');
    }
    inference.close();
  });
});
