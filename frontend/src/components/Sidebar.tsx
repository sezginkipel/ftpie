import { useState } from "react";

interface Bookmark {
  id: string;
  name: string;
  host: string;
  protocol: string;
}

export function Sidebar() {
  const [bookmarks] = useState<Bookmark[]>([]);
  const [gitBranch, setGitBranch] = useState<string>("");

  return (
    <div className="w-52 border-r border-border bg-card flex flex-col overflow-hidden">
      {/* Bookmarks Section */}
      <div className="px-3 py-2 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Bookmarks
      </div>
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {bookmarks.length === 0 ? (
          <p className="px-3 py-1 text-muted-foreground">No bookmarks yet.</p>
        ) : (
          bookmarks.map((bm) => (
            <div
              key={bm.id}
              className="px-3 py-1.5 hover:bg-accent/50 cursor-pointer text-foreground"
            >
              <div className="font-medium truncate">{bm.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {bm.protocol}://{bm.host}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Git Section */}
      <div className="px-3 py-2 border-t border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Git
      </div>
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {gitBranch ? (
          <div className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="text-green-400">●</span>
              <span className="font-mono text-xs">{gitBranch}</span>
            </div>
          </div>
        ) : (
          <p className="px-3 py-1 text-muted-foreground">No repository.</p>
        )}
      </div>
    </div>
  );
}
