'use client';

// 模型表格壳（行项/计价展示在 model-row-item，创建/编辑/绑定/测试弹窗与共享表单在同目录分域文件）

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import type { ChannelOption, AdminModelRow } from '@tillgate/api-client';
import { ModelRowItem } from './model-row-item';

export { CreateModelDialog } from './create-model-dialog';

export function ModelsTable({
  models,
  channels,
}: {
  readonly models: ReadonlyArray<AdminModelRow>;
  readonly channels: ReadonlyArray<ChannelOption>;
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('externalName')}</TableHead>
          <TableHead>{t('realModel')}</TableHead>
          <TableHead className="text-right">{t('inputPrice')}</TableHead>
          <TableHead className="text-right">{t('outputPrice')}</TableHead>
          <TableHead className="text-right">{t('cachePrice')}</TableHead>
          <TableHead>{t('fallbackModels')}</TableHead>
          <TableHead className="w-44">{tc('status')}</TableHead>
          <TableHead className="text-right">{t('context')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
              {t('noModels')}
            </TableCell>
          </TableRow>
        ) : (
          models.map((m) => <ModelRowItem key={m.id} model={m} channels={channels} />)
        )}
      </TableBody>
    </Table>
  );
}
