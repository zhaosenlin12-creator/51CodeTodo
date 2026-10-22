import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReminderSettings, isSettingsInteractionAllowed, isSmartArrangeInteractionBusy } from "./SettingsPage";

function renderReminder(enabled: boolean) {
  return renderToStaticMarkup(
    <ReminderSettings
      enabled={enabled}
      timeInput="09:00"
      error={null}
      busy={false}
      dueWord="交付"
      onEnabledChange={() => undefined}
      onTimeInputChange={() => undefined}
      onCommit={() => undefined}
    />,
  );
}

describe("SettingsPage 渐进展示与忙状态", () => {
  it("每日提醒关闭时不渲染提醒时间", () => {
    const html = renderReminder(false);

    expect(html).toContain("每日提醒");
    expect(html).not.toContain("提醒时间");
    expect(html).not.toContain('placeholder="09:00"');
  });

  it("每日提醒开启时才渲染提醒时间", () => {
    const html = renderReminder(true);

    expect(html).toContain("提醒时间");
    expect(html).toContain('value="09:00"');
  });

  it("设置保存或智能整理来源切换任一进行中都禁止 Key 操作", () => {
    expect(isSmartArrangeInteractionBusy(false, false)).toBe(false);
    expect(isSmartArrangeInteractionBusy(true, false)).toBe(true);
    expect(isSmartArrangeInteractionBusy(false, true)).toBe(true);
  });

  it("智能整理来源切换未完成时拒绝普通设置写入", () => {
    let updateCalls = 0;
    const sourceSwitchPending = true;

    if (isSettingsInteractionAllowed(false, sourceSwitchPending)) updateCalls += 1;

    expect(updateCalls).toBe(0);
    expect(isSettingsInteractionAllowed(false, false)).toBe(true);
    expect(isSettingsInteractionAllowed(true, false)).toBe(false);
  });
});
