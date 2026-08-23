'use client';

import { useRef, useState } from 'react';
import { SendIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  Card,
  CardContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@tokenlens/ui';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

/** 操练场 BYOK：用户自持 API Key 直连同域网关（Key 仅存本会话，不经服务端保存） */
const KEY_STORAGE = 'pg:api-key';

export function Playground({ models }: { models: string[] }) {
  const t = useTranslations('playground');
  const tCommon = useTranslations('common');
  const [model, setModel] = useState(models[0] ?? '');
  const [apiKey, setApiKey] = useState<string>(() => {
    try {
      return sessionStorage.getItem(KEY_STORAGE) ?? '';
    } catch {
      return '';
    }
  });
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function onKeyChange(value: string): void {
    setApiKey(value);
    try {
      sessionStorage.setItem(KEY_STORAGE, value);
    } catch {
      /* 隐私模式等场景静默 */
    }
  }

  async function send() {
    const text = input.trim();
    const key = apiKey.trim();
    if (!text || !model || pending) return;
    if (!key.startsWith('ag_')) {
      setError(t('keyMissing'));
      return;
    }
    setError(null);
    const next: Msg[] = [
      ...messages,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ];
    setMessages(next);
    setInput('');
    setPending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          messages: next
            .slice(0, -1)
            .map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? t('requestFailed', { status: res.status }));
      }
      // fetch-stream 消费（SSE data 帧 → delta.content 增量渲染）
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              setMessages((cur) => {
                const copy = [...cur];
                copy[copy.length - 1] = {
                  role: 'assistant',
                  content: copy[copy.length - 1]!.content + delta,
                };
                return copy;
              });
            }
          } catch {
            /* 非 JSON 帧忽略 */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => onKeyChange(e.target.value)}
          placeholder={t('keyPlaceholder')}
          className="w-72"
          autoComplete="off"
        />
        <Select
          value={model}
          onValueChange={(v) => {
            if (typeof v === 'string' && v !== '') setModel(v);
          }}
        >
          <SelectTrigger className="w-64">
            <SelectValue placeholder={t('selectModel')} />
          </SelectTrigger>
          <SelectContent>
            {(models as readonly string[]).map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {messages.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => setMessages([])}>
            {tCommon('clear')}
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="min-h-64 space-y-3 p-4">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                <div
                  className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user' ? 'bg-primary/10' : 'bg-muted'
                  }`}
                >
                  {m.content || (pending && i === messages.length - 1 ? '…' : '')}
                </div>
              </div>
            ))
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={t('inputPlaceholder')}
          rows={2}
        />
        {pending ? (
          <Button variant="outline" onClick={() => abortRef.current?.abort()}>
            {t('stop')}
          </Button>
        ) : (
          <Button onClick={send} disabled={!input.trim() || !model}>
            <SendIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
