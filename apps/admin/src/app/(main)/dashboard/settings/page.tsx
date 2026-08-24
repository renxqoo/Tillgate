import { requirePermission } from '@/server/get-admin';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import type { AdminMeInfo } from '@tillgate/api-client';
import { adminApi } from '@/server/admin-api';

import { SettingsContent } from '@/features/settings/settings-content';

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
  return <SettingsContent me={me} error={loadError} />;
}
