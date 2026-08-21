import { getTranslations } from 'next-intl/server';

import { adminFetch, ApiError, type AdminMeInfo } from '@ai-gateway/api-client';

import { SettingsContent } from '../settings/_components/settings-content';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const tc = await getTranslations('common');
  let me: AdminMeInfo | null = null;
  let error: string | null = null;
  try {
    me = await adminFetch<AdminMeInfo>('/v1/me');
  } catch (e) {
    error = e instanceof ApiError ? e.message : tc('loadFailed');
  }
  return <SettingsContent me={me} error={error} />;
}
