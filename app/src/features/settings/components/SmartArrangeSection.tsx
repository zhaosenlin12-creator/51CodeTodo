import type { ReactNode } from "react";
import type { SmartArrangePreferences, SmartArrangeSnapshot } from "../../../contracts/smartArrange";
import SettingsRow from "./SettingsRow";
import ToggleSwitch from "./ToggleSwitch";

export interface SmartArrangeSettingsProps {
  officialServicesEnabled?: boolean;
  snapshot: SmartArrangeSnapshot | null;
  busy: boolean;
  onChange(preferences: SmartArrangePreferences): void;
  /** 自带 Key 的厂商与密钥设置；仅在用户明确选择该来源后展示。 */
  children?: ReactNode;
}

/** 服务来源不使用内联折叠（避免套娃）；随智能整理组整体折叠展开。 */
export default function SmartArrangeSection({ snapshot, busy, onChange, children, officialServicesEnabled = true }: SmartArrangeSettingsProps) {
  const preferences = snapshot?.preferences ?? { enabled: false, source: "official" as const };
  return <>
    <SettingsRow title="启用智能整理" hint={snapshot ? "开启后，粘贴文字或截图会自动填写待办" : "正在读取智能整理设置…"} control={
      <ToggleSwitch label="启用智能整理" checked={preferences.enabled} disabled={busy || !snapshot} onToggle={enabled => onChange({ ...preferences, enabled })} />
    } />
    {preferences.enabled && officialServicesEnabled && <>
      <SettingsRow title="服务来源" control={
        <div className="settings-segment" role="group" aria-label="服务来源">
          {([['official', '官方服务'], ['byok', '自带 Key']] as const).map(([source, label]) =>
            <button type="button" key={source} className={preferences.source === source ? "active" : ""} aria-pressed={preferences.source === source} disabled={busy || !snapshot} onClick={() => onChange({ ...preferences, source })}>{label}</button>)}
        </div>
      } />
      {preferences.source === "byok" && children}
    </>}
    {!officialServicesEnabled && children}
  </>;
}
