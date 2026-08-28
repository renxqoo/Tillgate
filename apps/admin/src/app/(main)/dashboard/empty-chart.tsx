export function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-62.5 items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
