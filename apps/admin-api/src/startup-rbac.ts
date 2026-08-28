/**
 * 启动前 RBAC 对账（进程入口策略——assembly 只做依赖组装，不持启动副作用）：
 * 代码侧 enforced 注册表 ⊆ DB 活动码——发版新增码忘了补种子即拒启
 * （fail-closed，绝不静默全站 403）;DB 不可达仅告警（本地/单测形态）。
 * exit 注入缝与 shutdown 同款——拒启分支可测。
 */
import { ENFORCED_CODES } from '@tillgate/control-plane';
import type { Logger } from '@tillgate/runtime';

export function verifyRbacStartup(input: {
  activeCodes: () => Promise<readonly string[]>;
  logger: Pick<Logger, 'error' | 'warn'>;
  /** 退出函数注入缝（测试;缺省 process.exit） */
  exit?: (code: number) => void;
}): void {
  const exit = input.exit ?? ((code: number) => process.exit(code));
  // 对账非阻塞：不挡监听启动;发现缺失再杀进程
  void (async () => {
    try {
      const active = new Set(await input.activeCodes());
      for (const code of ENFORCED_CODES) {
        if (!active.has(code)) {
          input.logger.error(
            { code },
            'rbac enforced code missing from DB permissions — refusing to start',
          );
          exit(1);
          return;
        }
      }
    } catch {
      input.logger.warn('rbac startup reconciliation skipped (db unreachable)');
    }
  })();
}
