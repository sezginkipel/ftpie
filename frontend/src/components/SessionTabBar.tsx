import { useSessionStore } from "../store/sessionStore";

const PROTOCOL_COLORS: Record<string, string> = {
  ftp: "bg-blue-400",
  ftps: "bg-green-400",
  ftps_implicit: "bg-emerald-400",
  sftp: "bg-violet-400",
};

export function SessionTabBar() {
  const { sessions, activeSessionId, setActive, disconnect } = useSessionStore();

  if (sessions.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-card/60 overflow-x-auto shrink-0">
      {sessions.map((s) => {
        const isActive = s.id === activeSessionId;
        const dot = PROTOCOL_COLORS[s.protocol] ?? "bg-gray-400";
        return (
          <div
            key={s.id}
            onClick={() => setActive(s.id)}
            className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs cursor-pointer select-none shrink-0 border transition-colors ${
              isActive
                ? "bg-primary/15 border-primary/40 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
            <span className="font-mono max-w-[140px] truncate">
              {s.protocol}://{s.username}@{s.host}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                disconnect(s.id);
              }}
              className="ml-0.5 text-muted-foreground hover:text-red-400 leading-none"
              title="Disconnect"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
