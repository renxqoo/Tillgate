'use client';

// 渠道资金弹窗共享的渠道下拉字段（充值/调整弹窗共用，勿在两个弹窗里各抄一份）

import {
  FieldLabel,
  FormItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import type { ChannelOption } from '@tillgate/api-client';

export function ChannelSelect({
  value,
  onChange,
  channels,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  channels: ReadonlyArray<ChannelOption>;
  id: string;
}) {
  const t = useTranslations('channelFunds');
  return (
    <FormItem>
      <FieldLabel htmlFor={id}>{t('channel')}</FieldLabel>
      {/* items 同源映射：Value 回显渠道名而非原始 id */}
      <Select
        value={value}
        onValueChange={(v) => onChange(v ?? '')}
        items={channels.map((c) => ({ value: String(c.id), label: c.name }))}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={t('selectChannel')} />
        </SelectTrigger>
        <SelectContent>
          {channels.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormItem>
  );
}
