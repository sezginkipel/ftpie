import { useSessionStore } from "../store/sessionStore";

export function StatusBar() {
  const { sessions, activeSessionId } = useSessionStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="flex items-center gap-4 px-4 py-1 border-t border-border bg-card text-xs text-muted-foreground">
      {activeSession ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            <span>{activeSession.protocol.toUpperCase()}</span>
            <span className="text-foreground">{activeSession.host}</span>
          </span>
          <span className="text-muted-foreground">|</span>
          <span>{activeSession.username}</span>
        </>
      ) : (
        <span>Not connected</span>
      )}
      <span className="ml-auto">ftpie v0.1.0</span>
    </div>
  );
}
