import { adminFetch, ApiError, type AdminMeInfo } from '@ai-gateway/api-client';

import { SettingsContent } from '../settings/_components/settings-content';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  let me: AdminMeInfo | null = null;
  let error: string | null = null;
  try {
    me = await adminFetch<AdminMeInfo>('/api/admin/me');
  } catch (e) {
    error = e instanceof ApiError ? e.message : '加载失败';
  }
  return <SettingsContent me={me} error={error} />;
}
