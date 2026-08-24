'use client';

// 套餐表格壳（行项在 plan-row-item，创建/编辑/发放弹窗与表单在同目录分域文件）

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import type { PlanRow } from '@tillgate/api-client';
import { PlanRowItem } from './plan-row-item';

export { CreatePlanDialog } from './create-plan-dialog';

export function PlansTable({ plans }: { readonly plans: ReadonlyArray<PlanRow> }) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');

  /** 周期天数展示：30→月，365→年，其余按天。 */
  function fmtPeriod(days: number): string {
    if (days === 30) return t('periodMonth');
    if (days === 365) return t('periodYear');
    return t('periodDays', { days });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead className="w-20">{tc('type')}</TableHead>
          <TableHead className="w-16">{t('tier')}</TableHead>
          <TableHead className="text-right">{t('price')}</TableHead>
          <TableHead className="w-20">{t('period')}</TableHead>
          <TableHead className="text-right">{t('quota')}</TableHead>
          <TableHead className="w-20">{t('seats')}</TableHead>
          <TableHead className="w-24">{tc('status')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
              {t('noPlans')}
            </TableCell>
          </TableRow>
        ) : (
          plans.map((p) => <PlanRowItem key={p.id} plan={p} fmtPeriod={fmtPeriod} tUi={tUi} />)
        )}
      </TableBody>
    </Table>
  );
}
