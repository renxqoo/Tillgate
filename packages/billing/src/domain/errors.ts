/**
 * billing 错误目录（AGENT.md §11：码的唯一登记处，随迁移单元增量登记）。
 * 禁止自造错误类体系；需要精确捕获处经 entry() 固化子类（errors README §2.1 路径 B）。
 * U0 条目：金额域输入拒绝。
 */
import { defineErrorCatalog } from '@tokenlens/errors';

export const BillingErrors = defineErrorCatalog('billing', {
  invalid_amount: {
    category: 'invalid_input',
    message: 'Invalid monetary amount',
    zh: '金额非法',
  },
});
