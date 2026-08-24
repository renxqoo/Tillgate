'use client';

// 限流编辑弹窗：rpm/tpm + 信用模型字段（user/key 显隐），受控 open 由列表状态驱动

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
} from '@tillgate/ui';
import { GaugeIcon } from 'lucide-react';
import type { useTranslations } from 'next-intl';
import type { RateLimitItem, RateLimitKind } from '@/features/channels/rate-limit-types';

export function RateLimitEditDialog({
  editing,
  rpm,
  tpm,
  credit,
  dailySpend,
  pending,
  showCreditField,
  showDailySpendField,
  onClose,
  onSave,
  setRpm,
  setTpm,
  setCredit,
  setDailySpend,
  t,
  tc,
  tUi,
}: {
  editing: { kind: RateLimitKind; item: RateLimitItem } | null;
  rpm: string;
  tpm: string;
  credit: string;
  dailySpend: string;
  pending: boolean;
  showCreditField: boolean;
  showDailySpendField: boolean;
  onClose: () => void;
  onSave: () => void;
  setRpm: (v: string) => void;
  setTpm: (v: string) => void;
  setCredit: (v: string) => void;
  setDailySpend: (v: string) => void;
  t: ReturnType<typeof useTranslations<'rateLimits'>>;
  tc: ReturnType<typeof useTranslations<'common'>>;
  tUi: ReturnType<typeof useTranslations<'ui'>>;
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GaugeIcon className="size-4" />
            {t('editTitle')}
          </DialogTitle>
          <DialogDescription>
            {editing ? t('editDescription', { label: editing.item.label }) : ''}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormItem>
            <FieldLabel>{t('rpmLabel')}</FieldLabel>
            <Input
              type="number"
              min={1}
              placeholder={tc('unlimited')}
              value={rpm}
              onChange={(e) => setRpm(e.target.value)}
            />
          </FormItem>
          <FormItem>
            <FieldLabel>{t('tpmLabel')}</FieldLabel>
            <Input
              type="number"
              min={1}
              placeholder={tc('unlimited')}
              value={tpm}
              onChange={(e) => setTpm(e.target.value)}
            />
          </FormItem>
          {showCreditField ? (
            <FormItem>
              <FieldLabel>{t('creditLabel')}</FieldLabel>
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder="0"
                value={credit}
                onChange={(e) => setCredit(e.target.value)}
              />
            </FormItem>
          ) : null}
          {showDailySpendField ? (
            <FormItem>
              <FieldLabel>{t('dailySpendLabel')}</FieldLabel>
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder={tc('unlimited')}
                value={dailySpend}
                onChange={(e) => setDailySpend(e.target.value)}
              />
            </FormItem>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {tUi('cancel')}
          </Button>
          <Button onClick={onSave} disabled={pending}>
            {pending ? t('saving') : tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
