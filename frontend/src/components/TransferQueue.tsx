export function TransferQueue() {
  // TODO: Zustand store'dan transfer items al
  return (
    <div className="border-t border-border bg-card" style={{ height: "120px" }}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">Transfer Queue</span>
        <div className="flex items-center gap-2">
          <button className="text-xs px-2 py-0.5 border border-border rounded hover:bg-accent">
            ⏸ Pause All
          </button>
          <button className="text-xs px-2 py-0.5 border border-border rounded hover:bg-accent">
            Clear
          </button>
        </div>
      </div>
      <div className="overflow-y-auto h-[84px] px-3 py-2 text-xs text-muted-foreground">
        <p>No active transfers.</p>
      </div>
    </div>
  );
}
