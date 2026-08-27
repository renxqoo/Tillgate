'use client';

/** 筛选按钮组（价格/状态两组共用：options 为 [值, label] 平铺，激活项高亮） */
export function FilterButtonGroup<K extends string>({
  options,
  active,
  onSelect,
}: {
  options: ReadonlyArray<readonly [K, string]>;
  active: K;
  onSelect: (k: K) => void;
}) {
  return (
    <div className="flex gap-1 text-xs">
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          onClick={() => onSelect(k)}
          className={`rounded-md px-2 py-1 ${active === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
