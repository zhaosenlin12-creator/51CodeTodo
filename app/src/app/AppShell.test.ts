import { describe, expect, it, vi } from "vitest";
import type { SettingsServices, SettingsSnapshot } from "../contracts/settings";
import { canInstallUpdate, createSettingsLeaveGate, leaveSettings, trackSettingsActivity } from "./AppShell";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const snapshot = {} as SettingsSnapshot;
function settingsServices(overrides: Partial<SettingsServices> = {}): SettingsServices {
  return {
    load: vi.fn(async () => snapshot),
    update: vi.fn(async () => snapshot),
    renameCustomer: vi.fn(async () => snapshot),
    hideCustomer: vi.fn(async () => snapshot),
    saveApiKey: vi.fn(async () => snapshot),
    clearApiKey: vi.fn(async () => snapshot),
    chooseDirectory: vi.fn(async () => null),
    applyDirectoryChange: vi.fn(async () => ({ snapshot, message: "" })),
    exportBackup: vi.fn(async () => null),
    exportMarkdown: vi.fn(async () => null),
    chooseBackupImport: vi.fn(async () => null),
    importBackup: vi.fn(async () => ({ snapshot, message: "" })),
    ...overrides,
  };
}

describe("安装更新忙碌保护", () => {
  it.each([
    "todoBusy", "todoEditorOpen", "todoLoginOpen", "accountBusy", "settingsBusy", "smartArrangeBusy", "themeSaving", "pinSaving", "installing",
  ] as const)("%s 活跃时禁止安装", blocker => {
    const state = {
      todoBusy: false, todoEditorOpen: false, todoLoginOpen: false, accountBusy: false,
      settingsBusy: false, smartArrangeBusy: false, themeSaving: false, pinSaving: false, installing: false,
      [blocker]: true,
    };
    expect(canInstallUpdate(state)).toBe(false);
  });

  it("没有草稿或请求进行时允许安装", () => {
    expect(canInstallUpdate({
      todoBusy: false, todoEditorOpen: false, todoLoginOpen: false, accountBusy: false,
      settingsBusy: false, smartArrangeBusy: false, themeSaving: false, pinSaving: false, installing: false,
    })).toBe(true);
  });

  it("设置写入从发起到落盘完成都上报忙碌", async () => {
    const saving = deferred<SettingsSnapshot>();
    const activity = vi.fn();
    const tracked = trackSettingsActivity(settingsServices({ update: vi.fn(() => saving.promise) }), activity);

    const request = tracked.update({ startWithWindows: true });
    expect(activity).toHaveBeenLastCalledWith(true);
    saving.resolve(snapshot);
    await request;
    expect(activity.mock.calls.map(call => call[0])).toEqual([true, false]);
  });

  it("登录或付款等待都不再锁住设置页返回", () => {
    const closeSettings = vi.fn();
    const message = vi.fn();
    const blockers = {
      todoBusy: false, todoEditorOpen: false, todoLoginOpen: false, accountBusy: true,
      settingsBusy: false, smartArrangeBusy: false, themeSaving: false, pinSaving: false, installing: false,
    };

    expect(leaveSettings({ closeSettings })).toBe(true);
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(canInstallUpdate(blockers)).toBe(false);
  });

  it("返回时关闭设置页", () => {
    const closeSettings = vi.fn();
    expect(leaveSettings({ closeSettings })).toBe(true);
    expect(closeSettings).toHaveBeenCalledOnce();
  });

  it("外部打开待办使用统一的返回门", () => {
    const closeSettings = vi.fn();
    const requestLeave = createSettingsLeaveGate({ closeSettings });
    expect(requestLeave()).toBe(true);
    expect(closeSettings).toHaveBeenCalledOnce();
  });


});
