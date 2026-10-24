import type { TodoServices } from "../contracts/todo";

export type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function nativeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error.trim()) return new Error(error);
  return new Error("操作未完成，请稍后重试");
}

export function createTodoServices(invoke: InvokeCommand): TodoServices {
  async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try { return await invoke<T>(command, args); }
    catch (error) { throw nativeError(error); }
  }
  return {
    listTasks: () => call("pometodo_list_tasks"),
    createTask: (draft) => call("pometodo_create_task", { draft }),
    updateTask: (id, draft) => call("pometodo_update_task", { id, draft }),
    setTaskStatus: (id, status) => call("pometodo_set_status", { id, status }),
    setTaskUrgent: (id, urgent) => call("pometodo_set_urgent", { id, urgent }),
    archiveTask: (id) => call("pometodo_archive_task", { id }),
    unarchiveTask: (id) => call("pometodo_unarchive_task", { id }),
    setTaskReminder: (id, reminderAt) => call("pometodo_set_reminder", { id, reminderAt }),
    snoozeReminder: (instanceId, minutes) =>
      call("pometodo_snooze_reminder", { instanceId, minutes }),
    cancelReminder: (instanceId) => call("pometodo_cancel_reminder", { instanceId }),
    deleteTask: (id) => call("pometodo_delete_task", { id }),
    recognizeClipboard: () => call("pometodo_recognize_clipboard"),
    arrangeText: (text: string) => call("pometodo_arrange_text", { text }),
    recognizeAttachment: (id: string) => call("pometodo_recognize_attachment", { id }),
    saveClipboardAttachment: () => call("pometodo_save_clipboard_attachment"),
    getAttachmentDataUrl: (path) => call("pometodo_attachment_data_url", { path }),
  };
}
