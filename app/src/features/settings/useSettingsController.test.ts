import { describe, expect, it } from "vitest";
import type {
  AppSettings,
  BackupImportPreview,
  DirectoryChangePreview,
  SettingsServices,
  SettingsSnapshot,
} from "../../contracts/settings";
import { createSettingsControllerCore } from "./useSettingsController";

const baseSettings: AppSettings = {
  theme: "system",
  startWithWindows: false,
  startMinimized: true,
  floatingBallEnabled: false,
  closeAction: "tray",
  dailyReminderEnabled: true,
  dailyReminderTime: "09:00",
  quickDueOptions: [{ label: "今天", days: 0 }],
  aiProvider: "deepseek",
  customerLabel: "客户",
};

const baseSnapshot: SettingsSnapshot = {
  settings: baseSettings,
  customers: [{ originalName: "李老板", displayName: "李老板", activeCount: 2 }],
  keyConfigured: { minimax: false, deepseek: false, qwen: false, glm: false },
  dataDirectory: "C:\\PomeTodo\\data",
  screenshotDirectory: "C:\\PomeTodo\\screenshots",
  version: "0.1.0",
};

function makeSnapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    ...baseSnapshot,
    settings: { ...baseSettings },
    customers: baseSnapshot.customers.map((row) => ({ ...row })),
    keyConfigured: { ...baseSnapshot.keyConfigured },
    ...overrides,
  };
}

function makeServices(overrides: Partial<SettingsServices> = {}): SettingsServices {
  return {
    load: () => Promise.resolve(makeSnapshot()),
    update: (patch) => Promise.resolve(makeSnapshot({ settings: { ...baseSettings, ...patch } })),
    renameCustomer: () => Promise.resolve(makeSnapshot()),
    hideCustomer: () => Promise.resolve(makeSnapshot({ customers: [] })),
    saveApiKey: () => Promise.resolve(makeSnapshot({ keyConfigured: { minimax: false, deepseek: true, qwen: false, glm: false } })),
    clearApiKey: () => Promise.resolve(makeSnapshot()),
    chooseDirectory: () => Promise.resolve(null),
    applyDirectoryChange: () =>
      Promise.resolve({ snapshot: makeSnapshot({ dataDirectory: "D:\\新目录" }), message: "数据目录已更换。" }),
    exportBackup: () => Promise.resolve({ message: "备份已导出。" }),
    exportMarkdown: () => Promise.resolve({ message: "清单已导出。" }),
    chooseBackupImport: () => Promise.resolve(null),
    importBackup: () =>
      Promise.resolve({ snapshot: makeSnapshot({ version: "0.1.0" }), message: "备份导入成功。" }),
    ...overrides,
  };
}

const directoryPreview: DirectoryChangePreview = {
  token: "token-data-1",
  kind: "data",
  source: "C:\\PomeTodo\\data",
  destination: "D:\\新目录",
  message: "当前任务数据会迁移到新目录。",
};

const importPreview: BackupImportPreview = {
  token: "token-import-1",
  fileName: "backup.zip",
  taskCount: 12,
  attachmentCount: 30,
  message: "导入会替换当前任务。",
};

describe("settings controller core", () => {
  it("loads the snapshot once and becomes ready", async () => {
    const core = createSettingsControllerCore(makeServices());
    await core.load();
    const state = core.getState();
    expect(state.phase).toBe("ready");
    expect(state.snapshot?.version).toBe("0.1.0");
    expect(state.loadError).toBeNull();
  });

  it("surfaces load failures instead of inventing default settings", async () => {
    const core = createSettingsControllerCore(
      makeServices({ load: () => Promise.reject(new Error("设置读取失败")) }),
    );
    await core.load();
    const state = core.getState();
    expect(state.phase).toBe("loadError");
    expect(state.loadError).toBe("设置读取失败");
    expect(state.snapshot).toBeNull();
  });

  it("recovers through a retry after a failed load", async () => {
    let calls = 0;
    const core = createSettingsControllerCore(
      makeServices({
        load: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error("第一次失败")) : Promise.resolve(makeSnapshot());
        },
      }),
    );
    await core.load();
    expect(core.getState().phase).toBe("loadError");

    await core.load();
    expect(core.getState().phase).toBe("ready");
    expect(core.getState().snapshot).not.toBeNull();
  });

  it("applies the returned snapshot and notifies the host after a successful update", async () => {
    const applied: SettingsSnapshot[] = [];
    const core = createSettingsControllerCore(makeServices(), {
      onSnapshotApplied: (snapshot) => applied.push(snapshot),
    });
    await core.load();

    const result = await core.update({ theme: "dark" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.settings.theme).toBe("dark");
    expect(core.getState().snapshot?.settings.theme).toBe("dark");
    expect(applied).toHaveLength(1);
    expect(core.getState().busy).toBe(false);
  });

  it("keeps the previous snapshot and reports the message when an update fails", async () => {
    const core = createSettingsControllerCore(
      makeServices({ update: () => Promise.reject(new Error("写入注册表失败")) }),
    );
    await core.load();

    const result = await core.update({ startWithWindows: true });

    expect(result).toEqual({ ok: false, message: "写入注册表失败" });
    expect(core.getState().snapshot?.settings.startWithWindows).toBe(false);
    expect(core.getState().busy).toBe(false);
  });

  it("rejects overlapping writes while one is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = createSettingsControllerCore(
      makeServices({ update: () => gate.then(() => makeSnapshot()) }),
    );
    await core.load();

    const first = core.update({ theme: "dark" });
    const second = await core.update({ theme: "light" });
    expect(second.ok).toBe(false);
    release();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    expect(core.getState().busy).toBe(false);
  });

  it("returns the rename result and notifies the host", async () => {
    const applied: SettingsSnapshot[] = [];
    const renamed = makeSnapshot({
      customers: [{ originalName: "李老板", displayName: "老李", activeCount: 2 }],
    });
    const core = createSettingsControllerCore(
      makeServices({ renameCustomer: () => Promise.resolve(renamed) }),
      { onSnapshotApplied: (snapshot) => applied.push(snapshot) },
    );
    await core.load();

    const result = await core.renameCustomer("李老板", "老李");

    expect(result.ok).toBe(true);
    expect(core.getState().snapshot?.customers[0].displayName).toBe("老李");
    expect(applied).toHaveLength(1);
  });

  it("reports an empty chooseDirectory result as a cancel without applying anything", async () => {
    const applied: SettingsSnapshot[] = [];
    let applyCalls = 0;
    const core = createSettingsControllerCore(
      makeServices({
        chooseDirectory: () => Promise.resolve(null),
        applyDirectoryChange: () => {
          applyCalls += 1;
          return Promise.resolve({ snapshot: makeSnapshot(), message: "" });
        },
      }),
      { onSnapshotApplied: () => applied.push(makeSnapshot()) },
    );
    await core.load();

    const result = await core.chooseDirectory("data");

    expect(result).toEqual({ ok: true, value: null });
    expect(applyCalls).toBe(0);
    expect(applied).toHaveLength(0);
  });

  it("reports chooseDirectory failures instead of treating them as cancel", async () => {
    const core = createSettingsControllerCore(
      makeServices({ chooseDirectory: () => Promise.reject(new Error("无法打开目录选择")) }),
    );
    await core.load();

    const result = await core.chooseDirectory("screenshots");

    expect(result).toEqual({ ok: false, message: "无法打开目录选择" });
  });

  it("applies the directory change only with a preview token", async () => {
    const applied: SettingsSnapshot[] = [];
    const core = createSettingsControllerCore(
      makeServices({ applyDirectoryChange: () => Promise.resolve({ snapshot: makeSnapshot({ dataDirectory: "D:\\新目录" }), message: "数据目录已更换。" }) }),
      { onSnapshotApplied: (snapshot) => applied.push(snapshot) },
    );
    await core.load();

    const result = await core.applyDirectoryChange("token-data-1");

    expect(result.ok).toBe(true);
    expect(core.getState().snapshot?.dataDirectory).toBe("D:\\新目录");
    expect(applied).toHaveLength(1);
  });

  it("keeps export cancellations quiet without notifying the host", async () => {
    const applied: SettingsSnapshot[] = [];
    const core = createSettingsControllerCore(makeServices({ exportBackup: () => Promise.resolve(null) }), {
      onSnapshotApplied: (snapshot) => applied.push(snapshot),
    });
    await core.load();

    const result = await core.exportBackup();

    expect(result).toEqual({ ok: true, value: null });
    expect(applied).toHaveLength(0);
  });

  it("returns the export message without a snapshot callback", async () => {
    const applied: SettingsSnapshot[] = [];
    const core = createSettingsControllerCore(
      makeServices({ exportBackup: () => Promise.resolve({ message: "备份已导出：backup.zip" }) }),
      { onSnapshotApplied: (snapshot) => applied.push(snapshot) },
    );
    await core.load();

    const result = await core.exportBackup();

    expect(result).toEqual({ ok: true, value: { message: "备份已导出：backup.zip" } });
    expect(applied).toHaveLength(0);
  });

  it("returns the import preview as-is and only imports on confirm", async () => {
    let importCalls = 0;
    const core = createSettingsControllerCore(
      makeServices({
        chooseBackupImport: () => Promise.resolve(importPreview),
        importBackup: () => {
          importCalls += 1;
          return Promise.resolve({ snapshot: makeSnapshot(), message: "备份导入成功。" });
        },
      }),
    );
    await core.load();

    const chosen = await core.chooseBackupImport();
    expect(chosen).toEqual({ ok: true, value: importPreview });
    expect(importCalls).toBe(0);

    const result = await core.importBackup(importPreview.token);
    expect(result.ok).toBe(true);
    expect(importCalls).toBe(1);
    expect(core.getState().busy).toBe(false);
  });

  it("reports import failures with a readable message", async () => {
    const core = createSettingsControllerCore(
      makeServices({ importBackup: () => Promise.reject(new Error("备份文件已损坏")) }),
    );
    await core.load();

    const result = await core.importBackup("token-import-1");

    expect(result).toEqual({ ok: false, message: "备份文件已损坏" });
    expect(core.getState().snapshot?.version).toBe("0.1.0");
  });

  it("surfaces key save success through keyConfigured and clears busy", async () => {
    const core = createSettingsControllerCore(makeServices());
    await core.load();

    const result = await core.saveApiKey("deepseek", "sk-test-123");

    expect(result.ok).toBe(true);
    expect(core.getState().snapshot?.keyConfigured.deepseek).toBe(true);
  });

  it("reports key save failures and keeps the previous state", async () => {
    const core = createSettingsControllerCore(
      makeServices({ saveApiKey: () => Promise.reject(new Error("密钥加密保存失败")) }),
    );
    await core.load();

    const result = await core.saveApiKey("deepseek", "sk-test-123");

    expect(result).toEqual({ ok: false, message: "密钥加密保存失败" });
    expect(core.getState().snapshot?.keyConfigured.deepseek).toBe(false);
  });
});
