/**
 * 待办控制器：列表加载、搜索筛选、写入与剪贴板调用的状态管理。
 * 核心状态机不依赖 React，可在测试中注入成功/失败的假服务直接驱动；
 * hook 层通过 useSyncExternalStore 订阅，服务失败以结果返回给界面提示，
 * 不吞掉错误，也不在成功写入后把重新加载失败当作保存失败。
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  TodoDraft,
  TodoFilter,
  TodoRecognitionDraft,
  TodoServices,
  TodoStatus,
  TodoStatusCounts,
  TodoTask,
} from "../../contracts/todo";
import {
  getFilteredTodoTasks,
  getTodoStatusCounts,
  getVisibleTodoTasks,
  matchTodoSearch,
} from "./todoModel";
import { readableTodoError, todoTexts } from "./todoTexts";

export type TodoWriteResult = { ok: true } | { ok: false; message: string };

export type TodoAttachmentSaveResult =
  | { ok: true; path: string | null }
  | { ok: false; message: string };

/** local/empty 是正常结果，不作为失败展示；异常以 error 返回。 */
export type TodoRecognitionOutcome =
  | { kind: "ai"; draft: TodoRecognitionDraft; message?: string }
  | { kind: "local"; draft: TodoRecognitionDraft; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string };

export interface TodoControllerState {
  loading: boolean;
  loadError: string | null;
  search: string;
  status: TodoFilter;
  tasks: TodoTask[];
  visibleTasks: TodoTask[];
  counts: TodoStatusCounts;
  saving: boolean;
  recognizing: boolean;
  busyTaskIds: readonly string[];
  deletingTaskId: string | null;
  addingAttachment: boolean;
}

const EMPTY_COUNTS: TodoStatusCounts = { today: 0, pending: 0, in_progress: 0, waiting: 0, completed: 0 };

function upsertTask(tasks: TodoTask[], saved: TodoTask) {
  const index = tasks.findIndex((task) => task.id === saved.id);
  if (index < 0) return [...tasks, saved];
  const next = [...tasks];
  next[index] = saved;
  return next;
}

export interface TodoControllerCore {
  subscribe(listener: () => void): () => void;
  getState(): TodoControllerState;
  recompute(): void;
  dispose(): void;
  setSearch(value: string): void;
  setStatus(value: TodoFilter): void;
  loadTasks(): Promise<void>;
  ensureTask(id: string): Promise<TodoTask | null>;
  getTaskById(id: string): TodoTask | undefined;
  createTask(draft: TodoDraft): Promise<TodoWriteResult>;
  updateTask(id: string, draft: TodoDraft): Promise<TodoWriteResult>;
  setTaskStatus(id: string, status: TodoStatus): Promise<TodoWriteResult>;
  setTaskUrgent(id: string, urgent: boolean): Promise<TodoWriteResult>;
  archiveTask(id: string): Promise<TodoWriteResult>;
  unarchiveTask(id: string): Promise<TodoWriteResult>;
  setTaskReminder(id: string, reminderAt: string | null): Promise<TodoWriteResult>;
  snoozeReminder(instanceId: string, minutes: number): Promise<TodoWriteResult>;
  cancelReminder(instanceId: string): Promise<TodoWriteResult>;
  deleteTask(id: string): Promise<TodoWriteResult>;
  recognizeClipboard(): Promise<TodoRecognitionOutcome | null>;
  arrangeText(text: string): Promise<TodoRecognitionOutcome | null>;
  /** 识别附件箱中指定截图（附件优先，替代读剪贴板）。 */
  recognizeAttachment(id: string): Promise<TodoRecognitionOutcome | null>;
  saveClipboardAttachment(): Promise<TodoAttachmentSaveResult>;
  getAttachmentDataUrl(path: string): Promise<string>;
}

export function createTodoControllerCore(services: TodoServices): TodoControllerCore {
  const listeners = new Set<() => void>();
  let loadSeq = 0;
  const writesDuringLoad = new Map<number, Set<string>>();
  let now = new Date();
  let state: TodoControllerState = {
    loading: false,
    loadError: null,
    search: "",
    status: "today",
    tasks: [],
    visibleTasks: [],
    counts: EMPTY_COUNTS,
    saving: false,
    recognizing: false,
    busyTaskIds: [],
    deletingTaskId: null,
    addingAttachment: false,
  };

  function emit() {
    for (const listener of listeners) listener();
  }

  function recordWrite(id: string) {
    for (const changedIds of writesDuringLoad.values()) changedIds.add(id);
  }

  function patch(partial: Partial<TodoControllerState>) {
    now = new Date();
    const next = { ...state, ...partial };
    const matched = next.tasks.filter((task) => matchTodoSearch(task, next.search));
    state = {
      ...next,
      visibleTasks: getVisibleTodoTasks(next.search.trim() ? matched : getFilteredTodoTasks(matched, next.status, now)),
      counts: getTodoStatusCounts(next.tasks, now),
    };
    emit();
  }

  const core: TodoControllerCore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    recompute() {
      patch({});
    },
    dispose() {
      listeners.clear();
    },
    setSearch(value) {
      patch({ search: value });
    },
    setStatus(value) {
      patch({ status: value });
    },
    async loadTasks() {
      const seq = ++loadSeq;
      const changedIds = new Set<string>();
      writesDuringLoad.set(seq, changedIds);
      patch({ loading: true });
      try {
        const tasks = await services.listTasks();
        if (seq !== loadSeq) return;
        // A disk write may finish before an older list response reaches the UI.
        // Keep those saved records (and deletions) while loading untouched tasks.
        const merged = tasks.filter((task) => !changedIds.has(task.id));
        merged.push(...state.tasks.filter((task) => changedIds.has(task.id)));
        patch({ loading: false, loadError: null, tasks: merged });
      } catch (error) {
        if (seq !== loadSeq) return;
        patch({ loading: false, loadError: readableTodoError(error, todoTexts.loadFailed) });
      } finally {
        writesDuringLoad.delete(seq);
      }
    },
    async ensureTask(id) {
      const found = state.tasks.find((task) => task.id === id);
      if (found) return found;
      await core.loadTasks();
      return state.tasks.find((task) => task.id === id) ?? null;
    },
    getTaskById(id) {
      return state.tasks.find((task) => task.id === id);
    },
    async createTask(draft) {
      if (state.saving || state.recognizing) return { ok: false, message: todoTexts.actionBusy };
      patch({ saving: true });
      try {
        const saved = await services.createTask(draft);
        recordWrite(saved.id);
        patch({ saving: false, tasks: upsertTask(state.tasks, saved) });
        return { ok: true };
      } catch (error) {
        patch({ saving: false });
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async updateTask(id, draft) {
      if (state.saving || state.recognizing || state.busyTaskIds.includes(id)) return { ok: false, message: todoTexts.actionBusy };
      patch({ saving: true, busyTaskIds: [...state.busyTaskIds, id] });
      try {
        const saved = await services.updateTask(id, draft);
        recordWrite(id);
        patch({ saving: false, busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id), tasks: upsertTask(state.tasks, saved) });
        return { ok: true };
      } catch (error) {
        patch({ saving: false, busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id) });
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async setTaskStatus(id, status) {
      if (state.busyTaskIds.includes(id)) return { ok: false, message: todoTexts.actionBusy };
      patch({ busyTaskIds: [...state.busyTaskIds, id] });
      try {
        const saved = await services.setTaskStatus(id, status);
        recordWrite(id);
        patch({
          busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id),
          tasks: upsertTask(state.tasks, saved),
        });
        return { ok: true };
      } catch (error) {
        patch({ busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id) });
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async setTaskUrgent(id, urgent) {
      if (state.busyTaskIds.includes(id)) return { ok: false, message: todoTexts.actionBusy };
      patch({ busyTaskIds: [...state.busyTaskIds, id] });
      try {
        const saved = await services.setTaskUrgent(id, urgent);
        recordWrite(id);
        patch({
          busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id),
          tasks: upsertTask(state.tasks, saved),
        });
        return { ok: true };
      } catch (error) {
        patch({ busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id) });
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async archiveTask(id) {
      if (state.busyTaskIds.includes(id)) return { ok: false, message: todoTexts.actionBusy };
      const archive = services.archiveTask;
      if (!archive) return { ok: false, message: todoTexts.saveFailed };
      patch({ busyTaskIds: [...state.busyTaskIds, id] });
      try {
        const saved = await archive(id);
        recordWrite(id);
        patch({
          busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id),
          tasks: upsertTask(state.tasks, saved),
        });
        return { ok: true };
      } catch (error) {
        patch({ busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id) });
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async unarchiveTask(id) {
      if (state.busyTaskIds.includes(id)) return { ok: false, message: todoTexts.actionBusy };
      const unarchive = services.unarchiveTask;
      if (!unarchive) return { ok: false, message: todoTexts.saveFailed };
      patch({ busyTaskIds: [...state.busyTaskIds, id] });
      try {
        const saved = await unarchive(id);
        recordWrite(id);
        patch({
          busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id),
          tasks: upsertTask(state.tasks, saved),
        });
        return { ok: true };
      } catch (error) {
        patch({ busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id) });
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async setTaskReminder(id, reminderAt) {
      if (state.busyTaskIds.includes(id)) return { ok: false, message: todoTexts.actionBusy };
      const setReminder = services.setTaskReminder;
      if (!setReminder) return { ok: false, message: todoTexts.saveFailed };
      patch({ busyTaskIds: [...state.busyTaskIds, id] });
      try {
        const saved = await setReminder(id, reminderAt);
        recordWrite(id);
        patch({
          busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id),
          tasks: upsertTask(state.tasks, saved),
        });
        return { ok: true };
      } catch (error) {
        patch({ busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id) });
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async snoozeReminder(instanceId, minutes) {
      const snooze = services.snoozeReminder;
      if (!snooze) return { ok: false, message: todoTexts.saveFailed };
      try {
        await snooze(instanceId, minutes);
        recordWrite(instanceId);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async cancelReminder(instanceId) {
      const cancel = services.cancelReminder;
      if (!cancel) return { ok: false, message: todoTexts.saveFailed };
      try {
        await cancel(instanceId);
        recordWrite(instanceId);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    async deleteTask(id) {
      if (state.deletingTaskId || state.busyTaskIds.includes(id)) return { ok: false, message: todoTexts.actionBusy };
      patch({ deletingTaskId: id, busyTaskIds: [...state.busyTaskIds, id] });
      try {
        await services.deleteTask(id);
        recordWrite(id);
        patch({
          deletingTaskId: null,
          busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id),
          tasks: state.tasks.filter((task) => task.id !== id),
        });
        return { ok: true };
      } catch (error) {
        patch({ deletingTaskId: null, busyTaskIds: state.busyTaskIds.filter((busyId) => busyId !== id) });
        return { ok: false, message: readableTodoError(error, todoTexts.saveFailed) };
      }
    },
    /** 识别或保存中的草稿不接受新识别，调用方忽略本次触发。 */
    async recognizeAttachment(id: string) {
      if (state.recognizing || state.saving) return null;
      patch({ recognizing: true });
      try {
        const result = await services.recognizeAttachment(id);
        if (result.kind === "ai") return result;
        if (result.kind === "local") {
          return { kind: "local", draft: result.draft, message: result.message };
        }
        return { kind: "empty", message: result.message };
      } catch (error) {
        return {
          kind: "error",
          message: readableTodoError(error, todoTexts.recognizeClipboardFailure),
        };
      } finally {
        patch({ recognizing: false });
      }
    },
    async recognizeClipboard() {
      if (state.recognizing || state.saving) return null;
      patch({ recognizing: true });
      try {
        const result = await services.recognizeClipboard();
        if (result.kind === "ai") return result;
        if (result.kind === "local") {
          return { kind: "local", draft: result.draft, message: result.message };
        }
        return { kind: "empty", message: result.message };
      } catch (error) {
        return {
          kind: "error",
          message: readableTodoError(error, todoTexts.recognizeClipboardFailure),
        };
      } finally {
        patch({ recognizing: false });
      }
    },
    async arrangeText(text: string) {
      if (state.recognizing || state.saving) return null;
      patch({ recognizing: true });
      try {
        const result = await services.arrangeText(text);
        if (result.kind === "ai") return result;
        if (result.kind === "local") {
          return { kind: "local", draft: result.draft, message: result.message };
        }
        return { kind: "empty", message: result.message };
      } catch (error) {
        return {
          kind: "error",
          message: readableTodoError(error, todoTexts.recognizeClipboardFailure),
        };
      } finally {
        patch({ recognizing: false });
      }
    },
    async saveClipboardAttachment() {
      if (state.addingAttachment) return { ok: false, message: todoTexts.actionBusy };
      patch({ addingAttachment: true });
      try {
        const path = await services.saveClipboardAttachment();
        return { ok: true, path };
      } catch (error) {
        return { ok: false, message: readableTodoError(error, todoTexts.addAttachmentFailed) };
      } finally {
        patch({ addingAttachment: false });
      }
    },
    getAttachmentDataUrl(path: string) {
      return services.getAttachmentDataUrl(path);
    },
  };

  return core;
}

export function useTodoController(services: TodoServices) {
  const core = useMemo(() => createTodoControllerCore(services), [services]);
  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);

  useEffect(() => {
    void core.loadTasks();
    return () => core.dispose();
  }, [core]);

  useEffect(() => {
    const timer = window.setInterval(() => core.recompute(), 60000);
    return () => window.clearInterval(timer);
  }, [core]);

  return { core, state };
}
