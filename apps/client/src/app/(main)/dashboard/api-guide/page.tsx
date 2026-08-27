import { BookOpenTextIcon } from 'lucide-react';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';

import { BaseUrlBadge } from '@/features/public/base-url-badge';

import { CodeSample } from './code-sample';
import { Section } from './section';

export const dynamic = 'force-dynamic';

/** 端点速查表：kind/note 存 apiGuide.endpoints.{id} 目录键 */
const ENDPOINTS: Array<{ method: string; path: string; id: string }> = [
  { method: 'POST', path: '/v1/chat/completions', id: 'chat' },
  { method: 'POST', path: '/v1/images/generations', id: 'imagesGen' },
  { method: 'POST', path: '/v1/audio/speech', id: 'tts' },
  { method: 'POST', path: '/v1/audio/transcriptions', id: 'stt' },
  { method: 'POST', path: '/v1/audio/translations', id: 'translate' },
  { method: 'POST', path: '/v1/images/edits', id: 'imageEdit' },
  { method: 'POST', path: '/v1/embeddings', id: 'embeddings' },
  { method: 'POST', path: '/v1/video/generations', id: 'video' },
  { method: 'POST', path: '/v1/music/generations', id: 'music' },
  { method: 'POST', path: '/v1/messages', id: 'anthropic' },
  { method: 'POST', path: '/v1beta/models/:model:generateContent', id: 'gemini' },
  { method: 'POST', path: '/v1/completions', id: 'completions' },
  { method: 'POST', path: '/v1/responses', id: 'responses' },
  { method: 'POST', path: '/v1/rerank', id: 'rerank' },
  { method: 'GET', path: '/v1/models', id: 'models' },
  { method: 'POST', path: '/oauth/token', id: 'oauth' },
];

/** 当前部署的站点地址（示例与徽章同源，复制即用）：反代场景取 x-forwarded-host */
function siteOrigin(h: Headers): string {
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3001';
  const proto =
    h.get('x-forwarded-proto') ??
    (/^(localhost|127\.|192\.168\.|10\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** 逐端点示例代码（纯模板字符串，模块级构造以压平页面函数行数） */
function buildGuideSamples(opts: {
  t: (key: string) => string;
  origin: string;
  key: string;
  appId: string;
  appSecret: string;
}) {
  const { t, origin, key: KEY, appId: APP_ID, appSecret: APP_SECRET } = opts;
  const BASE = `${origin}/v1`;

  const QUICK_PY = `from openai import OpenAI

client = OpenAI(
    base_url="${BASE}",
    api_key="${KEY}",  # ${t('cKeyComment')}
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",  # ${t('cModelsComment')}
    messages=[{"role": "user", "content": "${t('cHello')}"}],
)
print(resp.choices[0].message.content)`;

  const QUICK_CURL = `curl ${BASE}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "${t('cHello')}"}]
  }'`;

  const STREAM_JS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE}', apiKey: '${KEY}' });

const stream = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: '${t('cJoke')}' }],
  stream: true, // ${t('cSseComment')}
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}`;

  const VISION_CURL = `curl ${BASE}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "${t('cWhatsInImage')}"},
        {"type": "image_url", "image_url": {"url": "https://example.com/cat.png"}}
      ]
    }]
  }'`;

  const IMAGES_CURL = `curl ${BASE}/images/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "qwen-image", "prompt": "${t('cCatPrompt')}", "n": 1, "size": "1024x1024"}'`;

  const TTS_CURL = `curl ${BASE}/audio/speech \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "tts-1", "input": "${t('cWeather')}", "voice": "alloy"}' \\
  --output speech.mp3`;

  const STT_CURL = `curl ${BASE}/audio/transcriptions \\
  -H "Authorization: Bearer ${KEY}" \\
  -F file=@ recording.mp3 \\
  -F model=whisper-1`;

  const EMBED_CURL = `curl ${BASE}/embeddings \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "text-embedding-3-small", "input": "${t('cEmbedText')}"}'`;

  const VIDEO_CURL = `# ${t('cVideoStep1')}
curl ${BASE}/video/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "video-01", "prompt": "${t('cWavePrompt')}"}'

# ${t('cVideoStep2')}
curl ${BASE}/videos/${t('cTaskId')} -H "Authorization: Bearer ${KEY}"`;

  const MUSIC_CURL = `curl ${BASE}/music/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "music-01", "prompt": "${t('cPianoPrompt')}", "duration": 30}'`;

  const CLAUDE_PY = `from anthropic import Anthropic

# ${t('cAnthropicComment')}
client = Anthropic(base_url="${BASE}", api_key="${KEY}")

msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "${t('cHello')}"}],
)
print(msg.content[0].text)`;

  const GEMINI_CURL = `curl "${origin}/v1beta/models/gemini-2.5-flash:generateContent" \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"contents": [{"parts": [{"text": "${t('cHello')}"}]}]}'
# ${t('cGeminiStreamComment')}`;

  const OAUTH_TOKEN = `curl -X POST ${origin}/oauth/token \\
  -H "Content-Type: application/json" \\
  -d '{
    "grant_type": "client_credentials",
    "client_id": "${APP_ID}",
    "client_secret": "${APP_SECRET}"
  }'
# → {"access_token": "<JWT>", "expires_in": ...}
# ${t('cJwtComment')}`;

  const MODELS_CURL = `curl ${BASE}/models -H "Authorization: Bearer ${KEY}"`;

  return {
    QUICK_PY,
    QUICK_CURL,
    STREAM_JS,
    VISION_CURL,
    IMAGES_CURL,
    TTS_CURL,
    STT_CURL,
    EMBED_CURL,
    VIDEO_CURL,
    MUSIC_CURL,
    CLAUDE_PY,
    GEMINI_CURL,
    OAUTH_TOKEN,
    MODELS_CURL,
  };
}

export default async function ApiGuidePage() {
  const t = await getTranslations('apiGuide');
  // 示例统一使用当前部署的真实地址（与 BaseUrlBadge 同源）——复制即可用，无需改域名
  const origin = siteOrigin(await headers());
  const BASE = `${origin}/v1`;
  const s = buildGuideSamples({
    t,
    origin,
    key: t('sampleKey'),
    appId: t('sampleAppId'),
    appSecret: t('sampleAppSecret'),
  });

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BookOpenTextIcon className="size-5 text-muted-foreground" />
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <div className="pt-1">
          <BaseUrlBadge base={BASE} />
        </div>
      </div>

      <Section title={t('quickStartTitle')} desc={t('quickStartDesc')}>
        <CodeSample code={s.QUICK_PY} lang="python (openai SDK)" />
        <CodeSample code={s.QUICK_CURL} lang="curl" />
      </Section>

      <Section title={t('streamTitle')} desc={t('streamDesc')}>
        <CodeSample code={s.STREAM_JS} lang="javascript (openai SDK)" />
      </Section>

      <Section title={t('visionTitle')} desc={t('visionDesc')}>
        <CodeSample code={s.VISION_CURL} lang="curl" />
      </Section>

      <Section title={t('imagesTitle')} desc={t('imagesDesc')}>
        <CodeSample code={s.IMAGES_CURL} lang="curl" />
      </Section>

      <Section title={t('audioTitle')} desc={t('audioDesc')}>
        <CodeSample code={s.TTS_CURL} lang={t('langTts')} />
        <CodeSample code={s.STT_CURL} lang={t('langStt')} />
      </Section>

      <Section title={t('embedTitle')}>
        <CodeSample code={s.EMBED_CURL} lang="curl" />
      </Section>

      <Section title={t('avTitle')} desc={t('avDesc')}>
        <CodeSample code={s.VIDEO_CURL} lang={t('langVideo')} />
        <CodeSample code={s.MUSIC_CURL} lang={t('langMusic')} />
      </Section>

      <Section title={t('directTitle')} desc={t('directDesc')}>
        <CodeSample code={s.CLAUDE_PY} lang="python (anthropic SDK)" />
        <CodeSample code={s.GEMINI_CURL} lang={t('langGemini')} />
      </Section>

      <Section title={t('agentTitle')} desc={t('agentDesc')}>
        <CodeSample code={s.OAUTH_TOKEN} lang="curl" />
      </Section>

      <Section title={t('modelsTitle')} desc={t('modelsDesc')}>
        <CodeSample code={s.MODELS_CURL} lang="curl" />
      </Section>

      <Section title={t('tableTitle')} desc={t('tableDesc')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">{t('colMethod')}</TableHead>
              <TableHead>{t('colPath')}</TableHead>
              <TableHead className="w-28">{t('colCapability')}</TableHead>
              <TableHead className="hidden @xl/main:table-cell">{t('colNote')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ENDPOINTS.map((ep) => (
              <TableRow key={ep.path + ep.method}>
                <TableCell className="font-mono text-xs">{ep.method}</TableCell>
                <TableCell className="font-mono text-xs">{ep.path}</TableCell>
                <TableCell className="text-xs">{t(`endpoints.${ep.id}.kind`)}</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground @xl/main:table-cell">
                  {t(`endpoints.${ep.id}.note`)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}
