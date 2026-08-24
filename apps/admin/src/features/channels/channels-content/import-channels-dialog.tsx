'use client';

// 渠道批量导入弹窗：JSON 数组粘贴 → importChannelsAction

import { Button, Textarea } from '@tillgate/ui';
import { FormDialog } from '@/components/form-dialog';
import { UploadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useActionResult } from '@/components/action-toast';

export function ImportChannelsDialog() {
  const t = useTranslations('channels');
  const notify = useActionResult();
  const [text, setText] = useState('');

  const onSubmitClick = async () => {
    let channels: Array<{
      provider: string;
      name: string;
      apiKey: string;
      models?: string;
      weight?: number;
      priority?: number;
    }> = [];
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('JSON array required');
      channels = parsed;
    } catch {
      toast.error(t('invalidJson'));
      return false;
    }
    const { importChannelsAction } = await import('@/server/channels-actions');
    const res = await importChannelsAction(channels);
    if (!notify(res, t('importFailed'))) return false;
    toast.success(t('imported', { count: res.created ?? channels.length }));
    setText('');
    return true;
  };

  return (
    <FormDialog
      trigger={
        <Button variant="outline">
          <UploadIcon />
          {t('import')}
        </Button>
      }
      title={
        <>
          <UploadIcon /> {t('importTitle')}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('importDescription')}
      submitLabel={t('importSubmit')}
      onSubmitClick={onSubmitClick}
    >
      <Textarea
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="font-mono text-xs"
        placeholder={
          '[\n  {"provider":"OpenAI","name":"openai-main","apiKey":"sk-xxx","models":"gpt-4o"}\n]'
        }
      />
    </FormDialog>
  );
}
