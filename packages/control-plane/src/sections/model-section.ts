/**
 * models 域装配段：方法级委托与依赖装配从 facade 逐字搬迁；
 * 返回 { models } 分组，类型锚定 ControlPlane——公共契约仍由 facade 接口锁定。
 */
import type { ControlPlane } from '../control-plane';
import type { SectionDeps } from './section-deps';
import { createModel } from '../application/models/create-model';
import { updateModel } from '../application/models/update-model';
import { deleteModel } from '../application/models/delete-model';
import { undeleteModel } from '../application/models/undelete-model';
import { listModels } from '../application/models/list-models';
import { bindModelChannels } from '../application/models/bind-model-channels';
import { probeModel } from '../application/models/probe-model';

export function createModelSection({
  env,
  stores,
  audit,
}: SectionDeps): Pick<ControlPlane, 'models'> {
  return {
    models: {
      create: (input) => createModel({ db: env.db, stores: { model: stores.model }, audit }, input),
      update: (input) => updateModel({ db: env.db, stores: { model: stores.model }, audit }, input),
      delete: (input) => deleteModel({ db: env.db, stores: { model: stores.model }, audit }, input),
      undelete: (input) =>
        undeleteModel({ db: env.db, stores: { model: stores.model }, audit }, input),
      list: (query) => listModels({ db: env.db, stores: { model: stores.model } }, query),
      bindChannels: (input) =>
        bindModelChannels({ db: env.db, stores: { model: stores.model }, audit }, input),
      probe: (mappingId) =>
        probeModel(
          { db: env.db, stores: { model: stores.model }, cipher: env.cipher, probe: env.probe },
          mappingId,
        ),
    },
  };
}
