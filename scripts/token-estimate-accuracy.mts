/**
 * token 估算准确率实测（真实上游）。
 *
 * 对数据库里「真实渠道上架模型」（排除 mock 与 fb-/tmodel- 前缀等测试残留），
 * 发 3 类 prompt（中文/英文/代码），用供应商返回的真实 usage 对比
 * estimateInputTokens / estimateOutputTokens 的偏差率。
 *
 * 运行：bun scripts/token-estimate-accuracy.mts
 */
import { loadEnv, psql, q } from './security-audit/helpers.mts';
import { decrypt } from '../packages/core/src/index.js';
import { createAi, estimateInputTokens, estimateOutputTokens } from '../packages/ai/src/index.js';

loadEnv();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? '';

/** 真实供应商（排除 mock 与测试残留 provider 名） */
const REAL_PROVIDERS = ['deepseek', 'minimax', 'openrouter', 'ollama-lan'];

/** 3 类 prompt：中文（CJK）/ 英文（单词）/ 代码（数字+符号密集） */
const SCENARIOS = [
  {
    id: 'zh',
    name: '中文',
    content: '请用一句话介绍北京的天气特点，并列举三个中国主要城市。',
  },
  {
    id: 'en',
    name: '英文',
    content: 'Explain what a tokenizer is in a large language model, in two sentences.',
  },
  {
    id: 'code',
    name: '代码',
    content:
      'Return a JSON object: {"id": 1234567890, "name": "demo", "tags": [1, 22, 333, 4444]}. Output only the JSON.',
  },
] as const;

interface Row {
  provider: string;
  channel: string;
  base: string;
  keyEnc: string;
  external: string;
  realModel: string;
}

function loadRows(): Row[] {
  const providerList = REAL_PROVIDERS.map((p) => q(p)).join(', ');
  const sql =
    'SELECT p.name, c.name, COALESCE(c.base_url_override, p.base_url) AS base, c.api_key_enc, ' +
    'm.external_name, m.real_model ' +
    'FROM model_mappings m JOIN model_channels mc ON mc.mapping_id = m.id ' +
    'JOIN channels c ON c.id = mc.channel_id JOIN providers p ON p.id = c.provider_id ' +
    `WHERE m.status = 0 AND c.status = 0 AND p.name IN (${providerList}) ` +
    "AND m.external_name NOT LIKE 'fb-%' AND m.external_name NOT LIKE 'tmodel-%' " +
    "AND m.external_name NOT LIKE 'mc-test%' AND m.external_name NOT LIKE '__bind%' " +
    'ORDER BY p.name, m.external_name';
  const out = psql(sql);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [provider, channel, base, keyEnc, external, realModel] = line.split('|');
    return {
      provider: provider!,
      channel: channel!,
      base: base!,
      keyEnc: keyEnc!,
      external: external!,
      realModel: realModel!,
    };
  });
}

function makeAi() {
  return createAi({
    retry: { maxAttempts: 1, baseDelayMs: 300, maxDelayMs: 500, jitterRatio: 0, deadlineMs: 30_000, emptyCompletionRetries: 0 },
    breaker: { windowMs: 60_000, failureThreshold: 99, cooldownMs: 300_000, halfOpenProbe: true },
    stream: { heartbeatIdleMs: 30_000, inactivityTimeoutMs: 60_000 },
    timeout: { connectMs: 15_000, totalMs: 30_000 },
    deadCredential: { failureThreshold: 99, windowMs: 3_600_000 },
    allowLocalUrl: true, // ollama-lan 是内网 http
  });
}

function pct(est: number, real: number): string {
  if (real === 0) return 'n/a';
  return (((est - real) / real) * 100).toFixed(1) + '%';
}

async function main(): Promise<void> {
  const rows = loadRows();
  console.log(`\n加载 ${rows.length} 个 模型×渠道 组合\n`);

  const ai = makeAi();
  const results: Array<Record<string, string>> = [];

  for (const row of rows) {
    let apiKey: string;
    try {
      apiKey = decrypt(row.keyEnc, ENCRYPTION_KEY);
    } catch (e) {
      console.log(`[skip] ${row.provider}/${row.external} key 解密失败: ${(e as Error).message}`);
      continue;
    }
    const channel = { baseUrl: row.base, apiKey, protocol: 'openai-compatible' as const };

    for (const s of SCENARIOS) {
      const request = { model: row.realModel, messages: [{ role: 'user', content: s.content }], max_tokens: 60, temperature: 0 };
      const ctx = { requestId: `acc-${row.provider}-${s.id}-${Date.now()}`, model: row.realModel, providerName: row.provider };
      const estIn = estimateInputTokens(request);
      let line: Record<string, string> = {
        模型: `${row.provider}/${row.external}`,
        场景: s.name,
        '估入': String(estIn),
        '真入': '-',
        '入偏差': '-',
        '估出': '-',
        '真出': '-',
        '出偏差': '-',
      };
      try {
        const result = await ai.chat({ channel, request, ctx });
        if (result.status === 'success' && result.usage && result.usage.estimated === false) {
          const realIn = result.usage.inputTokens;
          const realOut = result.usage.outputTokens;
          const estOut = estimateOutputTokens(result.body);
          line = {
            模型: `${row.provider}/${row.external}`,
            场景: s.name,
            '估入': String(estIn),
            '真入': String(realIn),
            '入偏差': pct(estIn, realIn),
            '估出': String(estOut),
            '真出': String(realOut),
            '出偏差': pct(estOut, realOut),
          };
        } else if (result.status === 'error') {
          line['入偏差'] = `ERR:${result.error?.code}`;
          line['出偏差'] = `ERR:${result.error?.code}`;
        } else if (result.usage?.estimated === true) {
          line['入偏差'] = '无usage(已兜底)';
          line['出偏差'] = '无usage(已兜底)';
        }
      } catch (e) {
        line['入偏差'] = `EXC:${(e as Error).message.slice(0, 40)}`;
        line['出偏差'] = `EXC:${(e as Error).message.slice(0, 40)}`;
      }
      results.push(line);
      console.log(
        `${line['模型']} | ${line['场景']} | 估入=${line['估入']} 真入=${line['真入']} (${line['入偏差']}) | 估出=${line['估出']} 真出=${line['真出']} (${line['出偏差']})`,
      );
      // 免费模型限流友好：串行 + 短暂间隔
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
