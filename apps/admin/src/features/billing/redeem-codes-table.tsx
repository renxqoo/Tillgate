'use client';

import {
  DropdownMenuItem,
  RowActions,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tokenlens/ui';
import { defineStatusMeta } from '@/components/status-pill';
import { StatusPill } from '@/components/status-pill';
import { Loader2Icon, ShieldBanIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { RedeemCodeRow } from '@tokenlens/api-client';
import { fmtDateTime } from '@/lib/formatters';
import { ConfirmAction } from '@/components/confirm-action';

// 状态 tone 映射留模块级；label 是 redeemBatches 命名空间的 i18n key，渲染处用 t 解析
const STATUS_LABEL = defineStatusMeta({
  0: { label: 'statusUnused', tone: 'success' },
  1: { label: 'statusUsed', tone: 'info' },
  2: { label: 'statusRevoked', tone: 'neutral' },
  3: { label: 'statusExpired', tone: 'neutral' },
});

export function CodesTable({ codes }: { readonly codes: ReadonlyArray<RedeemCodeRow> }) {
  const t = useTranslations('redeemBatches');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">ID</TableHead>
          <TableHead>{t('codeMasked')}</TableHead>
          <TableHead className="w-24">{tc('status')}</TableHead>
          <TableHead>{t('usedBy')}</TableHead>
          <TableHead className="w-40">{t('usedAt')}</TableHead>
          <TableHead className="w-40">{t('expiresAt')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {codes.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
              {t('noCodes')}
            </TableCell>
          </TableRow>
        ) : (
          codes.map((c) => <CodeRowItem key={c.id} code={c} />)
        )}
      </TableBody>
    </Table>
  );
}

function CodeRowItem({ code }: { code: RedeemCodeRow }) {
  const t = useTranslations('redeemBatches');
  const tc = useTranslations('common');
  const meta = STATUS_LABEL.get(code.status);
  const revocable = code.status === 0;

  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground tabular-nums">#{code.id}</TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{code.codeMasked}</code>
      </TableCell>
      <TableCell>
        <StatusPill tone={meta.tone} label={t(meta.label)} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{code.usedBy ?? '—'}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{fmtDateTime(code.usedAt)}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{fmtDateTime(code.expiresAt)}</TableCell>
      <TableCell className="w-16 text-center">
        <RowActions label={tc('actions')}>
          <ConfirmAction
            confirm={t('revokeConfirm', { id: code.id })}
            action={async () =>
              (await import('@/server/redeem-batches-actions')).revokeCodeAction(code.id)
            }
            success={t('statusRevoked')}
          >
            {({ pending, onClick }) => (
              <DropdownMenuItem
                variant="destructive"
                disabled={pending || !revocable}
                onClick={onClick}
                title={revocable ? t('revoke') : t('notRevocable')}
              >
                {pending ? <Loader2Icon className="animate-spin" /> : <ShieldBanIcon />}
                {t('revoke')}
              </DropdownMenuItem>
            )}
          </ConfirmAction>
        </RowActions>
      </TableCell>
    </TableRow>
  );
}
