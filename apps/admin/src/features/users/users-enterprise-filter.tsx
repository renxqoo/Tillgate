import { BriefcaseIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ListFilterSelect } from '@/components/list-filter-select';

export function UsersEnterpriseFilter({ value }: { value: string }) {
  const tc = useTranslations('common');
  const t = useTranslations('users');

  return (
    <ListFilterSelect
      param="enterprise"
      value={value}
      allLabel={tc('allTypes')}
      icon={<BriefcaseIcon />}
      options={[
        { value: '1', label: t('enterprise') },
        { value: '0', label: t('personal') },
      ]}
    />
  );
}
