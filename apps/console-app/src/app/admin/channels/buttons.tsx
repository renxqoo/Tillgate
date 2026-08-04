'use client';

import { useState } from 'react';
import { CreateChannelForm, ImportChannelsForm } from './forms';

interface Provider {
  id: number;
  name: string;
}

/** 新建 + 批量导入 按钮 */
export default function ChannelButtons({ providers }: { providers: Provider[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  return (
    <div className="flex gap-2">
      <button onClick={() => setCreateOpen(true)} className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">
        新建渠道
      </button>
      <button onClick={() => setImportOpen(true)} className="rounded-md border px-4 py-1.5 text-sm hover:bg-muted">
        批量导入
      </button>
      <CreateChannelForm open={createOpen} onClose={() => setCreateOpen(false)} providers={providers} />
      <ImportChannelsForm open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
