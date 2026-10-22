/**
 * 设置控制器：可注入服务的状态机 + React hook。
 * core 不依赖 React，可在测试中注入成功/失败服务驱动真实异步流程。
 * 整页统一忙状态：写入进行中拒绝并发调用，避免后返回的旧 snapshot
 * 覆盖最新值；每次成功返回的新 snapshot 都通知宿主（onChanged）。
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  AppSettings,
  AiProvider,
  BackupImportPreview,
  DirectoryChangePreview,
  DirectoryKind,
  SettingsActionResult,
  SettingsServices,
  SettingsSnapshot,
} from "../../contracts/settings";
import { readableSettingsError, settingsTexts } from "./settingsTexts";

export type SettingsCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface SettingsControllerState {
  phase: "loading" | "ready" | "loadError";
  snapshot: SettingsSnapshot | null;
  loadError: string | null;
  busy: boolean;
  actionMessage: { tone: "success" | "error"; text: string } | null;
}

export interface SettingsHost {
  /** 每次已确认成功后的新 snapshot；export 不产生 snapshot 不回调。 */
  onSnapshotApplied?(snapshot: SettingsSnapshot): void;
}

export interface SettingsControllerCore {
  subscribe(listener: () => void): () => void;
  getState(): SettingsControllerState;
  dispose(): void;
  load(): Promise<void>;
  clearMessage(): void;
  setMessage(message: SettingsControllerState["actionMessage"]): void;
  update(patch: Partial<AppSettings>): Promise<SettingsCallResult<SettingsSnapshot>>;
  renameCustomer(originalName: string, displayName: string): Promise<SettingsCallResult<SettingsSnapshot>>;
  hideCustomer(originalName: string): Promise<SettingsCallResult<SettingsSnapshot>>;
  saveApiKey(provider: AiProvider, key: string): Promise<SettingsCallResult<SettingsSnapshot>>;
  clearApiKey(provider: AiProvider): Promise<SettingsCallResult<SettingsSnapshot>>;
  chooseDirectory(kind: DirectoryKind): Promise<SettingsCallResult<DirectoryChangePreview | null>>;
  applyDirectoryChange(token: string): Promise<SettingsCallResult<SettingsActionResult>>;
  exportBackup(): Promise<SettingsCallResult<{ message: string } | null>>;
  exportMarkdown(): Promise<SettingsCallResult<{ message: string } | null>>;
  chooseBackupImport(): Promise<SettingsCallResult<BackupImportPreview | null>>;
  importBackup(token: string): Promise<SettingsCallResult<SettingsActionResult>>;
}

const initialState: SettingsControllerState = {
  phase: "loading",
  snapshot: null,
  loadError: null,
  busy: false,
  actionMessage: null,
};

export function createSettingsControllerCore(
  services: SettingsServices,
  host: SettingsHost = {},
): SettingsControllerCore {
  const listeners = new Set<() => void>();
  let loadSeq = 0;
  let state: SettingsControllerState = { ...initialState };

  function emit() {
    for (const listener of listeners) listener();
  }

  function patch(partial: Partial<SettingsControllerState>) {
    state = { ...state, ...partial };
    emit();
  }

  /** resolve 表示服务已确认成功；用返回的新 snapshot 替换并通知宿主。 */
  function applySnapshot(snapshot: SettingsSnapshot, message: string): void {
    patch({
      snapshot,
      actionMessage: message ? { tone: "success", text: message } : null,
    });
    host.onSnapshotApplied?.(snapshot);
  }

  function busyRejected<T>(): SettingsCallResult<T> {
    return { ok: false, message: settingsTexts.actionBusy };
  }

  async function runSnapshotCall(
    run: () => Promise<SettingsSnapshot>,
    fallbackError: string,
  ): Promise<SettingsCallResult<SettingsSnapshot>> {
    if (state.busy) return busyRejected();
    patch({ busy: true });
    try {
      const snapshot = await run();
      applySnapshot(snapshot, "");
      return { ok: true, value: snapshot };
    } catch (error) {
      const message = readableSettingsError(error, fallbackError);
      patch({ actionMessage: { tone: "error", text: message } });
      return { ok: false, message };
    } finally {
      patch({ busy: false });
    }
  }

  const core: SettingsControllerCore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    dispose() {
      listeners.clear();
    },
    async load() {
      const seq = ++loadSeq;
      if (state.phase === "ready") {
        patch({ phase: "loading", loadError: null });
      }
      try {
        const snapshot = await services.load();
        if (seq !== loadSeq) return;
        patch({ phase: "ready", snapshot, loadError: null });
      } catch (error) {
        if (seq !== loadSeq) return;
        patch({
          phase: "loadError",
          loadError: readableSettingsError(error, settingsTexts.loadFailed),
          snapshot: null,
        });
      }
    },
    clearMessage() {
      if (state.actionMessage) patch({ actionMessage: null });
    },
    setMessage(message) {
      patch({ actionMessage: message });
    },
    async update(patch) {
      return runSnapshotCall(() => services.update(patch), settingsTexts.saveFailed);
    },
    async renameCustomer(originalName, displayName) {
      return runSnapshotCall(
        () => services.renameCustomer(originalName, displayName),
        settingsTexts.saveFailed,
      );
    },
    async hideCustomer(originalName) {
      return runSnapshotCall(() => services.hideCustomer(originalName), settingsTexts.saveFailed);
    },
    async saveApiKey(provider, key) {
      return runSnapshotCall(() => services.saveApiKey(provider, key), settingsTexts.saveFailed);
    },
    async clearApiKey(provider) {
      return runSnapshotCall(() => services.clearApiKey(provider), settingsTexts.saveFailed);
    },
    async chooseDirectory(kind) {
      if (state.busy) return busyRejected();
      patch({ busy: true });
      try {
        const preview = await services.chooseDirectory(kind);
        return { ok: true, value: preview };
      } catch (error) {
        const message = readableSettingsError(error, settingsTexts.chooseDirectoryFailed);
        patch({ actionMessage: { tone: "error", text: message } });
        return { ok: false, message };
      } finally {
        patch({ busy: false });
      }
    },
    async applyDirectoryChange(token) {
      if (state.busy) return busyRejected();
      patch({ busy: true });
      try {
        const result = await services.applyDirectoryChange(token);
        applySnapshot(result.snapshot, result.message);
        return { ok: true, value: result };
      } catch (error) {
        const message = readableSettingsError(error, settingsTexts.saveFailed);
        patch({ actionMessage: { tone: "error", text: message } });
        return { ok: false, message };
      } finally {
        patch({ busy: false });
      }
    },
    async exportBackup() {
      if (state.busy) return busyRejected();
      patch({ busy: true });
      try {
        const result = await services.exportBackup();
        // 导出没有新 snapshot，不通知宿主；取消（null）只算取消。
        if (result !== null) {
          patch({ actionMessage: { tone: "success", text: result.message } });
        }
        return { ok: true, value: result };
      } catch (error) {
        const message = readableSettingsError(error, settingsTexts.backupFailed);
        patch({ actionMessage: { tone: "error", text: message } });
        return { ok: false, message };
      } finally {
        patch({ busy: false });
      }
    },
    async exportMarkdown() {
      if (state.busy) return busyRejected();
      patch({ busy: true });
      try {
        const result = await services.exportMarkdown();
        if (result !== null) {
          patch({ actionMessage: { tone: "success", text: result.message } });
        }
        return { ok: true, value: result };
      } catch (error) {
        const message = readableSettingsError(error, settingsTexts.markdownExportFailed);
        patch({ actionMessage: { tone: "error", text: message } });
        return { ok: false, message };
      } finally {
        patch({ busy: false });
      }
    },
    async chooseBackupImport() {
      if (state.busy) return busyRejected();
      patch({ busy: true });
      try {
        const preview = await services.chooseBackupImport();
        return { ok: true, value: preview };
      } catch (error) {
        const message = readableSettingsError(error, settingsTexts.chooseImportFailed);
        patch({ actionMessage: { tone: "error", text: message } });
        return { ok: false, message };
      } finally {
        patch({ busy: false });
      }
    },
    async importBackup(token) {
      if (state.busy) return busyRejected();
      patch({ busy: true });
      try {
        const result = await services.importBackup(token);
        applySnapshot(result.snapshot, result.message);
        return { ok: true, value: result };
      } catch (error) {
        const message = readableSettingsError(error, settingsTexts.backupFailed);
        patch({ actionMessage: { tone: "error", text: message } });
        return { ok: false, message };
      } finally {
        patch({ busy: false });
      }
    },
  };

  return core;
}

export function useSettingsController(services: SettingsServices, host: SettingsHost = {}) {
  const hostRef = useRef(host);
  hostRef.current = host;
  const core = useMemo(
    () =>
      createSettingsControllerCore(services, {
        onSnapshotApplied: (snapshot) => hostRef.current.onSnapshotApplied?.(snapshot),
      }),
    [services],
  );
  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);

  useEffect(() => {
    void core.load();
    return () => core.dispose();
  }, [core]);

  return { core, state };
}
