import type { ReactNode } from 'react';

type ChatShellProps = {
  children: ReactNode;
};

type ChatShellRegionProps = {
  children: ReactNode;
};

export function ChatShell({ children }: ChatShellProps) {
  return (
    <main className="chat-shell" data-testid="harbor-chat-app">
      {children}
    </main>
  );
}

export function ChatShellRoute({ children }: ChatShellRegionProps) {
  return <div className="chat-shell__route">{children}</div>;
}

export function ChatShellWorkspace({ children }: ChatShellRegionProps) {
  return <div className="chat-shell__workspace">{children}</div>;
}

export function ChatShellVoyageRail({ children }: ChatShellRegionProps) {
  return (
    <aside aria-label="Voyage details" className="chat-shell__voyage-rail">
      {children}
    </aside>
  );
}
