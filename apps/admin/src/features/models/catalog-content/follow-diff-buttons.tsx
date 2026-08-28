'use client';

import { Button } from '@tillgate/ui';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** 一键跟进：把涨价/降价方向的漂移行全选（动作逻辑在编排器 applyDiff） */
export function FollowDiffButtons({
  onApplyDiff,
}: {
  onApplyDiff: (kind: 'price_up' | 'price_down') => void;
}) {
  const t = useTranslations('modelMarket');
  return (
    <div className="flex gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => onApplyDiff('price_up')}
      >
        <ArrowUpIcon className="mr-1 size-3" /> {t('followUp')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => onApplyDiff('price_down')}
      >
        <ArrowDownIcon className="mr-1 size-3" /> {t('followDown')}
      </Button>
    </div>
  );
}
