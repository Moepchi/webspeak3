import type { ReactNode } from "react";

export type ConnectionTabItem = {
  id: string;
  label: string;
  connected?: boolean;
  connecting?: boolean;
};

export type GreenteaSpeakChromeProps = {
  /** @deprecated Prefer `tabs` + `activeTabId` for multi-join. */
  connected?: boolean;
  /** @deprecated Prefer `tabs`. */
  serverName?: string;
  tabs?: ConnectionTabItem[];
  activeTabId?: string | null;
  onSelectTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  children?: ReactNode;
};

/**
 * GTS branding chrome: connection-tab strip (multi-join) + brand label when empty.
 * Renders children unchanged — WebSpeak keeps its own React state/handlers.
 */
export function GreenteaSpeakChrome({
  connected,
  serverName,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  children,
}: GreenteaSpeakChromeProps) {
  const resolvedTabs: ConnectionTabItem[] =
    tabs ??
    (connected
      ? [{ id: "legacy", label: (serverName ?? "").trim() || "GreenTeaSpeak", connected: true }]
      : []);

  const hasTabs = resolvedTabs.length > 0;

  return (
    <>
      {hasTabs ? (
        <div className="gts-connection-tabs" role="tablist" aria-label="Server-Verbindungen">
          {resolvedTabs.map((tab) => {
            const isActive = tab.id === (activeTabId ?? resolvedTabs[0]?.id);
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                className={`gts-connection-tab${isActive ? " gts-connection-tab-active" : ""}${
                  tab.connecting ? " gts-connection-tab-connecting" : ""
                }`}
                onClick={() => onSelectTab?.(tab.id)}
                title={tab.label}
              >
                <span className="gts-connection-tab-label">{tab.label}</span>
                {onCloseTab ? (
                  <button
                    type="button"
                    className="gts-connection-tab-close"
                    title="Verbindung trennen"
                    aria-label={`Tab schließen: ${tab.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="gts-connection-tabs gts-brand-strip">
          <span className="gts-brand-label">GreenTeaSpeak</span>
        </div>
      )}
      {children}
    </>
  );
}
