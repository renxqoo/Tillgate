import { AcceptInvite } from '@/features/orgs/accept-invite';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function AcceptInvitePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const token = sp.token ?? '';
  return <AcceptInvite token={token} />;
}
