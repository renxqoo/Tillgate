/** 区块头：chip + 标题 + 副文案（居中） */
export function SectionHeading({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="mx-auto mb-12 max-w-2xl space-y-4 text-center">
      <span className="inline-block rounded-full bg-[#3957ff]/10 px-3 py-1 text-xs font-medium text-[#3957ff]">
        {eyebrow}
      </span>
      <h2 className="text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">{title}</h2>
      <p className="text-[15px] leading-relaxed text-slate-500">{sub}</p>
    </div>
  );
}
