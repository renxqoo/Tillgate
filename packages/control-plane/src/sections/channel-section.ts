/**
 * channels 域装配段：方法级委托与依赖装配从 facade 逐字搬迁。
 * 单构建器超 50 行警戒线，按语义拆档案面（CRUD/列表/批量导入）与运营面
 * （探针/充值/调整/流水/凭证回读）两个内部构建器，导出面合并为
 * { channels } 分组——委托体与属性顺序逐字保持，类型锚定 ControlPlane。
 */
import type { ControlPlane } from '../control-plane';
import type { SectionDeps } from './section-deps';
import { createChannel } from '../application/channels/create-channel';
import { updateChannel } from '../application/channels/update-channel';
import { deleteChannel } from '../application/channels/delete-channel';
import { undeleteChannel } from '../application/channels/undelete-channel';
import { listChannels } from '../application/channels/list-channels';
import { importChannels } from '../application/channels/import-channels';
import { probeChannel } from '../application/channels/probe-channel';
import { rechargeChannel } from '../application/channels/recharge-channel';
import { adjustChannel } from '../application/channels/adjust-channel';
import { listRecharges } from '../application/channels/list-recharges';

type ChannelsGroup = ControlPlane['channels'];

/** 档案面：渠道记录 CRUD + 批量导入 */
function channelRecordsSection({
  env,
  stores,
  audit,
}: SectionDeps): Pick<
  ChannelsGroup,
  'create' | 'update' | 'delete' | 'undelete' | 'list' | 'import'
> {
  return {
    create: (input) =>
      createChannel(
        { db: env.db, stores: { channel: stores.channel }, cipher: env.cipher, audit },
        input,
      ),
    update: (input) =>
      updateChannel(
        { db: env.db, stores: { channel: stores.channel }, cipher: env.cipher, audit },
        input,
      ),
    delete: (input) =>
      deleteChannel(
        { db: env.db, stores: { channel: stores.channel, model: stores.model }, audit },
        input,
      ),
    undelete: (input) =>
      undeleteChannel({ db: env.db, stores: { channel: stores.channel }, audit }, input),
    list: (query) => listChannels({ db: env.db, stores: { channel: stores.channel } }, query),
    import: (input) =>
      importChannels(
        {
          db: env.db,
          stores: { channel: stores.channel, provider: stores.provider, model: stores.model },
          cipher: env.cipher,
          importMax: env.importMaxChannels,
          audit,
        },
        input,
      ),
  };
}

/** 运营面：上游探针 + 进货资金四动词 + 凭证回读 */
function channelOperationsSection({
  env,
  stores,
  auditTx,
  voucherStorage,
}: SectionDeps): Pick<
  ChannelsGroup,
  'probe' | 'recharge' | 'adjust' | 'listRecharges' | 'loadVoucher'
> {
  return {
    probe: (channelId) =>
      probeChannel(
        { db: env.db, stores: { channel: stores.channel }, cipher: env.cipher, probe: env.probe },
        channelId,
      ),
    recharge: (input) =>
      rechargeChannel(
        {
          db: env.db,
          stores: { channel: stores.channel, operations: stores.operations },
          voucherStorage,
          voucherMaxBytes: env.voucherMaxBytes,
          auditTx,
        },
        input,
      ),
    adjust: (input) =>
      adjustChannel(
        {
          db: env.db,
          stores: { channel: stores.channel, operations: stores.operations },
          auditTx,
        },
        input,
      ),
    listRecharges: (input) =>
      listRecharges({ db: env.db, stores: { channel: stores.channel } }, input),
    loadVoucher: (key) => voucherStorage.load(key),
  };
}

export function createChannelSection(deps: SectionDeps): Pick<ControlPlane, 'channels'> {
  return {
    channels: {
      ...channelRecordsSection(deps),
      ...channelOperationsSection(deps),
    },
  };
}
