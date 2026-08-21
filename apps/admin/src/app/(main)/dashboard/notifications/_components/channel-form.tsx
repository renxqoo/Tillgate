'use client';

import { useState } from 'react';
import { Loader2Icon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@ai-gateway/ui/components/ui/button';
import { Input } from '@ai-gateway/ui/components/ui/input';

import { createChannelAction } from '../actions';

/** 事件 id 固定；label 是 notifications 命名空间的 i18n key，渲染处用 t 解析 */
const EVENTS = [
  { id: 'channel_disabled', label: 'eventChannelDisabled' },
  { id: 'billing_dead', label: 'eventBillingDead' },
  { id: 'reconcile_discrepancy', label: 'eventReconcileDiscrepancy' },
  { id: 'balance_low', label: 'eventBalanceLow' },
  { id: 'context_overflow', label: 'eventContextOverflow' },
];

export function ChannelForm() {
  const t = useTranslations('notifications');
  const [type, setType] = useState<'webhook' | 'email'>('webhook');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [recipients, setRecipients] = useState('');
  const [events, setEvents] = useState<string[]>(['channel_disabled', 'billing_dead']);
  const [pending, setPending] = useState(false);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-48" placeholder={t('namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex gap-1">
          {(['webhook', 'email'] as const).map((kind) => (
            <Button key={kind} size="sm" variant={type === kind ? 'default' : 'outline'} onClick={() => setType(kind)}>
              {kind === 'webhook' ? 'Webhook' : t('email')}
            </Button>
          ))}
        </div>
      </div>
      {type === 'webhook' ? (
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-96" placeholder="https://example.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input className="max-w-64" placeholder={t('secretPlaceholder')} value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
      ) : (
        <Input className="max-w-96" placeholder={t('recipientsPlaceholder')} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
      )}
      <div className="flex flex-wrap gap-2">
        {EVENTS.map((ev) => (
          <Button
            key={ev.id}
            size="sm"
            variant={events.includes(ev.id) ? 'default' : 'outline'}
            onClick={() => setEvents((cur) => (cur.includes(ev.id) ? cur.filter((x) => x !== ev.id) : [...cur, ev.id]))}
          >
            {t(ev.label)}
          </Button>
        ))}
      </div>
      <Button
        disabled={pending || !name || events.length === 0}
        onClick={async () => {
          setPending(true);
          const res = await createChannelAction({
            name,
            type,
            config:
              type === 'webhook'
                ? { url, secret }
                : { recipients: recipients.split(/[,，\s]+/).filter(Boolean) },
            events,
          });
          setPending(false);
          if (res.error) {
            toast.error(res.error);
            return;
          }
          toast.success(t('created'));
          setName('');
          setUrl('');
          setSecret('');
          setRecipients('');
        }}
      >
        {pending ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
        {t('create')}
      </Button>
    </div>
  );
}
