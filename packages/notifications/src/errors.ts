/**
 * notifications 错误目录(AGENT.md §11:能力包自有目录,码带命名空间)。
 * 身份码 = `notifications.<key>`;message 英文、zh 中文,face 按码双语渲染(铁律 18)。
 * 码表封闭性由 __test__/errors.test.ts 快照锁死;新增码 = 契约变更,须同步 DESIGN §2.3。
 */
import { defineErrorCatalog } from '@tokenlens/errors';

export const notificationsErrors = defineErrorCatalog('notifications', {
  invalid_channel_input: {
    category: 'invalid_input',
    message: 'Invalid notification channel input',
    zh: '渠道参数不合法(名称 1-64、类型词表 webhook|email、config 形状、事件词表、status ∈ {0,1})',
  },
  channel_exists: {
    category: 'conflict',
    message: 'Notification channel name already exists',
    zh: '通知渠道重名',
  },
  channel_not_found: {
    category: 'not_found',
    message: 'Notification channel not found',
    zh: '通知渠道不存在',
  },
  unknown_event: {
    category: 'invalid_input',
    message: 'Unknown notification event',
    zh: '事件不在 NOTIFY_EVENTS 词表内(词表单一真相 = domain/events.ts)',
  },
  invalid_outbox_input: {
    category: 'invalid_input',
    message: 'Invalid outbox enqueue input',
    zh: '入箱参数不合法(dedupeKey 非空且 ≤128,payload 为对象,事件在词表内)',
  },
});
