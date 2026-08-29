/**
 * routingPolicy 段构建（facade 装配件——save 走用例+审计，观测直通 adapters）。
 */
import type { DbLike } from '@tillgate/db';
import { postgresRoutingPolicyStore } from '../adapters/postgres/routing-policy-store';
import { routingChannelsOverview } from '../adapters/postgres/routing-overview';
import { saveRoutingPolicy } from '../application/routing/save-policy';
import type { AuditSink } from '../ports/audit-sink';
import type { RoutingPolicyStore } from '../ports/routing-policy-store';
import type { ControlPlane } from '../control-plane';

export function composeRoutingPolicySurface(env: {
  db: DbLike;
  routingPolicyStore?: RoutingPolicyStore;
  audit: AuditSink;
}): Pick<ControlPlane, 'routingPolicy'> {
  const store = env.routingPolicyStore ?? postgresRoutingPolicyStore;
  return {
    routingPolicy: {
      get: () => store.findGlobal(env.db),
      save: (input) =>
        saveRoutingPolicy(
          { db: env.db, stores: { routingPolicy: store }, audit: env.audit },
          input,
        ),
      channelsOverview: (windowMs) => routingChannelsOverview(env.db, windowMs),
    },
  };
}
