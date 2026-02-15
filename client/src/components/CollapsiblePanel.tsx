import { ReactNode } from "react";
import { PanelId } from "../hooks/usePanelState";

export type CollapseDirection = "up" | "right";

interface CollapsiblePanelProps {
  panelId: PanelId;
  title: string;
  isExpanded: boolean;
  onToggle: (panelId: PanelId) => void;
  collapseDirection?: CollapseDirection;
  className?: string;
  children: ReactNode;
}

export function CollapsiblePanel({
  panelId,
  title,
  isExpanded,
  onToggle,
  collapseDirection = "up",
  className = "",
  children,
}: CollapsiblePanelProps) {
  const handleToggle = () => {
    onToggle(panelId);
  };

  const dirClass = collapseDirection === "right" ? "collapse-right" : "collapse-up";
  const stateClass = isExpanded ? "expanded" : "collapsed";

  if (collapseDirection === "right" && !isExpanded) {
    return (
      <section className={`panel collapsible-panel ${dirClass} ${stateClass} ${className}`}>
        <button
          className="panel-strip"
          onClick={handleToggle}
          aria-label={`Expand ${title}`}
          title={`Expand ${title}`}
        >
          <span className="panel-strip-title">{title}</span>
          <span className="panel-strip-icon">←</span>
        </button>
      </section>
    );
  }

  const collapseIcon = collapseDirection === "right" ? "→" : "↑";
  const expandIcon = collapseDirection === "right" ? "←" : "↓";

  return (
    <section className={`panel collapsible-panel ${dirClass} ${stateClass} ${className}`}>
      <div className="panel-header">
        <h2>{title}</h2>
        <button
          className="panel-toggle-btn"
          onClick={handleToggle}
          aria-label={isExpanded ? `Collapse ${title}` : `Expand ${title}`}
          title={isExpanded ? `Collapse ${title}` : `Expand ${title}`}
        >
          {isExpanded ? collapseIcon : expandIcon}
        </button>
      </div>
      {isExpanded && (
        <div className="panel-content">
          {children}
        </div>
      )}
    </section>
  );
}
