import type { ReactNode } from "react";

interface SettingsRowProps {
  title: string;
  hint?: string;
  /** 行尾控件（开关、时间输入等）。 */
  control?: ReactNode;
  /** 竖排布局（无行尾控件时，标题与内容上下排列）。 */
  stacked?: boolean;
  children?: ReactNode;
}

export default function SettingsRow({ title, hint, control, stacked = false, children }: SettingsRowProps) {
  if (stacked) {
    return (
      <div className="settings-row settings-row-stacked">
        <div className="settings-row-text">
          <span className="settings-row-title">{title}</span>
          {hint && <span className="settings-row-hint">{hint}</span>}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      {control}
      {children}
    </div>
  );
}
