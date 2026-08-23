import { useTranslations } from 'next-intl';
import { ListFilterSelect } from '@/components/list-filter-select';

export function UsersStatusFilter({ value }: { value: string }) {
  const tc = useTranslations('common');
  const t = useTranslations('users');

  return (
    <ListFilterSelect
      param="status"
      value={value}
      allLabel={tc('allStatuses')}
      options={[
        { value: '0', label: tc('active') },
        { value: '1', label: t('bannedShort') },
      ]}
    />
  );
}
