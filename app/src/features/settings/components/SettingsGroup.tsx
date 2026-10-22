import { useState, type ReactNode, type Ref } from "react";

interface SettingsGroupProps {
  title: string;
  collapsible?: boolean;
  /** 仅折叠组使用；默认折叠。 */
  defaultOpen?: boolean;
  /** 受控展开（与 onOpenChange 搭配；提供后忽略内部状态）。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 标题栏右侧控件（如场景胶囊、主题切换）；非折叠组使用。 */
  headerControl?: ReactNode;
  /** 短暂聚焦提示：边框变为强调色，与浮球菜单点击后的卡片提示一致。 */
  highlight?: boolean;
  /** 供外部滚动定位到本分组。 */
  groupRef?: Ref<HTMLElement>;
  children?: ReactNode;
}

/** 设置分组卡片；非折叠组始终渲染内容，可折叠组默认折叠。 */
export default function SettingsGroup({ title, collapsible = false, defaultOpen = false, open: openProp, onOpenChange, headerControl, highlight = false, groupRef, children }: SettingsGroupProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const bodyVisible = !collapsible || open;

  const toggleOpen = () => {
    const next = !open;
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  return (
    <section ref={groupRef} className={`settings-card${collapsible ? " collapsible" : ""}${bodyVisible ? " open" : ""}${highlight ? " settings-focus-flash" : ""}`}>
      {collapsible ? (
        <div className="settings-card-toggle-row">
          <button
            className="settings-card-toggle"
            type="button"
            aria-expanded={open}
            onClick={toggleOpen}
          >
            <span className="settings-card-title">{title}</span>
            <svg className="settings-card-chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {headerControl}
        </div>
      ) : (
        <div className="settings-card-header">
          <h2 className="settings-card-title">{title}</h2>
          {headerControl}
        </div>
      )}
      {children !== undefined && (
        <div className="settings-card-content-shell" aria-hidden={!bodyVisible} inert={!bodyVisible || undefined}>
          <div className="settings-card-content"><div className="settings-card-body settings-card-title-divider">{children}</div></div>
        </div>
      )}
    </section>
  );
}
