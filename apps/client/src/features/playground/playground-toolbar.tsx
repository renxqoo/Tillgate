'use client';

import { useTranslations } from 'next-intl';

import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@tillgate/ui';

/** 工具栏（Key 输入 + 模型选择 + 清空）：模块级组件，文案 hooks 自持 */
export function PlaygroundToolbar(props: {
  apiKey: string;
  onKeyChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  models: readonly string[];
  hasMessages: boolean;
  onClear: () => void;
}) {
  const t = useTranslations('playground');
  const tCommon = useTranslations('common');
  const { apiKey, onKeyChange, model, onModelChange, models, hasMessages, onClear } = props;
  return (
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
          if (typeof v === 'string' && v !== '') onModelChange(v);
        }}
        items={models.map((m) => ({ value: m, label: m }))}
      >
        <SelectTrigger className="w-64">
          <SelectValue placeholder={t('selectModel')} />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasMessages ? (
        <Button variant="outline" size="sm" onClick={onClear}>
          {tCommon('clear')}
        </Button>
      ) : null}
    </div>
  );
}
