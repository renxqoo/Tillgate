'use client';

import { DropdownMenuItem, DropdownMenuSeparator, RowActions } from '@tillgate/ui';
import Link from 'next/link';

import {
  BanknoteIcon,
  BriefcaseIcon,
  EyeIcon,
  GiftIcon,
  KeyRoundIcon,
  LandmarkIcon,
  Loader2Icon,
  ScaleIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  UserIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { RateCardOption, AdminUserRow } from '@tillgate/api-client';
import { AdjustDialog } from '../adjust-user-dialog';
import { DebitFloorDialog } from '../debit-floor-user-dialog';
import { FreezeDialog } from '../freeze-user-dialog';
import { GiftDialog } from '../gift-user-dialog';
import { PasswordDialog } from '../set-user-password-dialog';
import { BindRateCardDialog } from './bind-rate-card-dialog';

/** 行动作单元格：下拉菜单 + 挂载其下的受控弹窗组（从 UserRowItem 提出，规模/复杂度收敛） */
export function UserRowActionCell({
  user,
  pending,
  activeDialog,
  onDialogChange,
  onUnban,
  onToggleEnterprise,
  rateCards,
}: {
  user: AdminUserRow;
  pending: boolean;
  activeDialog: 'adjust' | 'gift' | 'floor' | 'password' | 'rate' | 'freeze' | null;
  onDialogChange: (
    dialog: 'adjust' | 'gift' | 'floor' | 'password' | 'rate' | 'freeze' | null,
  ) => void;
  onUnban: () => void;
  onToggleEnterprise: () => void;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  return (
    <>
      <RowActions label={tc('actions')}>
        <DropdownMenuItem onClick={() => onDialogChange('adjust')}>
          <ScaleIcon /> {t('adjust')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDialogChange('gift')}>
          <GiftIcon /> {t('gift')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDialogChange('password')}>
          <KeyRoundIcon /> {t('setPassword')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDialogChange('rate')}>
          <BanknoteIcon /> {t('bindRateCard')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDialogChange('floor')}>
          <LandmarkIcon /> {tc('setDebitFloor')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending} onClick={onToggleEnterprise}>
          {user.isEnterprise ? <UserIcon /> : <BriefcaseIcon />}
          {user.isEnterprise ? t('removeEnterprise') : t('setEnterprise')}
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link prefetch={false} href={`/dashboard/users/${user.id}`} />}>
          <EyeIcon /> {tc('detail')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant={user.status === 0 ? 'destructive' : 'default'}
          disabled={pending}
          onClick={user.status === 0 ? () => onDialogChange('freeze') : onUnban}
        >
          {pending && <Loader2Icon className="animate-spin" />}
          {!pending && user.status === 0 && <ShieldOffIcon />}
          {!pending && user.status !== 0 && <ShieldCheckIcon />}
          {user.status === 0 ? t('ban') : t('unban')}
        </DropdownMenuItem>
      </RowActions>
      <AdjustDialog
        user={user}
        trigger={null}
        open={activeDialog === 'adjust'}
        onOpenChange={(open) => !open && onDialogChange(null)}
      />
      <DebitFloorDialog
        user={user}
        trigger={null}
        open={activeDialog === 'floor'}
        onOpenChange={(open) => !open && onDialogChange(null)}
      />
      <FreezeDialog
        user={user}
        open={activeDialog === 'freeze'}
        onOpenChange={(open) => !open && onDialogChange(null)}
      />
      <GiftDialog
        user={user}
        trigger={null}
        open={activeDialog === 'gift'}
        onOpenChange={(open) => !open && onDialogChange(null)}
      />
      <PasswordDialog
        user={user}
        trigger={null}
        open={activeDialog === 'password'}
        onOpenChange={(open) => !open && onDialogChange(null)}
      />
      <BindRateCardDialog
        user={user}
        rateCards={rateCards}
        trigger={null}
        open={activeDialog === 'rate'}
        onOpenChange={(open) => !open && onDialogChange(null)}
      />
    </>
  );
}
