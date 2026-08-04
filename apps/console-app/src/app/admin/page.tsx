import { redirect } from 'next/navigation';

/** /admin 入口 → 重定向到管理后台仪表盘 */
export default function AdminPage() {
  redirect('/admin/stats');
}
