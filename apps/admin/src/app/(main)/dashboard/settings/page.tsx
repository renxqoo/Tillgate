import { hasPerm, requirePermission } from '@/server/get-admin';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import type { AdminMeInfo } from '@tillgate/api-client';
import { adminApi } from '@/server/admin-api';

import { SettingsContent } from '@/features/settings';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requirePermission('settings:read');
  const tc = await getTranslations('common');
  let me: AdminMeInfo | null = null;
  let loadError: string | null = null;
  try {
    me = await adminApi().get<AdminMeInfo>('/v1/me');
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : tc('loadFailed');
  }
  // 按钮级显隐：无 settings:update → 时区只读；
  // 无 settings:integrations → 集成/SMTP 操作位隐藏。权威判定在 admin-api ACL。
  const canUpdateTimezone = me != null && hasPerm(me, 'settings:update');
  const canManageIntegrations = me != null && hasPerm(me, 'settings:integrations');
  return (
    <SettingsContent
      me={me}
      error={loadError}
      canUpdateTimezone={canUpdateTimezone}
      canManageIntegrations={canManageIntegrations}
    />
  );
}
