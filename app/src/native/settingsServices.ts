import type { SettingsServices } from "../contracts/settings";
import { nativeError, type InvokeCommand } from "./todoServices";

export function createSettingsServices(invoke: InvokeCommand): SettingsServices {
  async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try { return await invoke<T>(command, args); }
    catch (error) { throw nativeError(error); }
  }
  return {
    load: () => call("pometodo_settings_load"),
    update: (patch) => call("pometodo_settings_update", { patch }),
    renameCustomer: (originalName, displayName) => call("pometodo_customer_rename", { originalName, displayName }),
    hideCustomer: (originalName) => call("pometodo_customer_hide", { originalName }),
    saveApiKey: (provider, key) => call("pometodo_key_save", { provider, key }),
    clearApiKey: (provider) => call("pometodo_key_clear", { provider }),
    chooseDirectory: (kind) => call("pometodo_choose_directory", { kind }),
    applyDirectoryChange: (token) => call("pometodo_apply_directory", { token }),
    exportBackup: () => call("pometodo_export_backup"),
    exportMarkdown: () => call("pometodo_export_markdown"),
    chooseBackupImport: () => call("pometodo_choose_backup_import"),
    importBackup: (token) => call("pometodo_import_backup", { token }),
  };
}
