import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

export interface RowProps {
  depth: number;
  label: string;
  icon?: IconName;
  iconClass?: string;
  tag?: { text: string; tone: "ok" | "warn" | "danger" | "info" };
  expandable?: boolean;
  expanded?: boolean;
  active?: boolean;
  muted?: boolean;
  title?: string;
  actions?: ReactNode;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function Row(p: RowProps) {
  return (
    <div
      className={"tree-row" + (p.active ? " active" : "") + (p.muted ? " muted" : "")}
      style={{ paddingLeft: 8 + p.depth * 14 }}
      title={p.title}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onContextMenu={p.onContextMenu}
    >
      <span className={"chev" + (p.expanded ? " open" : "") + (p.expandable ? "" : " hidden")}>
        <Icon name="chevron" size={12} />
      </span>
      {p.icon && <Icon name={p.icon} className={p.iconClass} size={14} />}
      <span className="label">{p.label}</span>
      {p.tag && <span className={"tag tag-" + p.tag.tone}>{p.tag.text}</span>}
      {p.actions && (
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          {p.actions}
        </span>
      )}
    </div>
  );
}

export function ActionButton(props: { title: string; icon: IconName; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={"ghost icon-btn" + (props.danger ? " danger-hover" : "")}
      title={props.title}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={13} />
    </button>
  );
}
