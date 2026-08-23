import { useTranslations } from 'next-intl';
import { ListFilterSelect } from '@/components/list-filter-select';

export function SubscriptionsStatusFilter({ value }: { value: string }) {
  const tc = useTranslations('common');
  const t = useTranslations('subscriptions');

  return (
    <ListFilterSelect
      param="status"
      value={value}
      allLabel={tc('allStatuses')}
      options={[
        { value: '0', label: t('statusActive') },
        { value: '1', label: t('statusExpired') },
        { value: '2', label: t('statusCancelled') },
      ]}
    />
  );
}
