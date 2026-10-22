import type { SyncConfigPatch, SyncConfigSnapshot, SyncMember, SyncServices, SyncSummary } from "../contracts/sync";
import { nativeError, type InvokeCommand } from "./todoServices";

/**
 * 团队同步命令封装；风格与 todoServices 一致：invoke 失败归一化为可读 Error，
 * 不在前端吞错或重试，参数按后端要求使用 camelCase。
 */
export function createSyncServices(invoke: InvokeCommand): SyncServices {
  async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try { return await invoke<T>(command, args); }
    catch (error) { throw nativeError(error); }
  }
  return {
    configGet: () => call<SyncConfigSnapshot>("pometodo_sync_config_get"),
    configUpdate: (patch: SyncConfigPatch) => call<SyncConfigSnapshot>("pometodo_sync_config_update", { patch }),
    join: () => call<SyncMember>("pometodo_sync_join"),
    syncNow: () => call<SyncSummary>("pometodo_sync_now"),
    members: () => call<SyncMember[]>("pometodo_sync_members"),
    setAssignee: (id: string, assignee: string | null) =>
      call<void>("pometodo_set_assignee", { id, assignee }),
  };
}
