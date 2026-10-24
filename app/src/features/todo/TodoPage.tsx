import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ReminderDispatch, TodoPageProps, TodoRecognitionDraft, TodoTask } from "../../contracts/todo";
import type { SyncMember } from "../../contracts/sync";
import { listen } from "@tauri-apps/api/event";
import SearchInput from "./components/SearchInput";
import StatusBar, { type SystemStatusProps } from "../../components/StatusBar";
import CompletedList from "./components/CompletedList";
import TodoCard from "./components/TodoCard";
import TodoCalendar, { shiftCalendarMonth } from "./components/TodoCalendar";
import TodoDialog, { type TodoRecognitionView } from "./components/TodoDialog";
import { todoIcons } from "./components/TodoIcons";
import type { TodoDraftFields, TodoFilter, TodoWorkflowAction } from "./todoModel";
import {
  TODO_ACTION_STATUS,
  TODO_BATCH_SIZE,
  applyTodoRecognitionDraft,
  dueWordsFor,
  getTodoDueInfo,
  getTodoDisplayGroups,
  getCompletedTodoGroups,
  getTodoListSlice,
  parseTodoDialogDateValue,
  parseTodoQuickDueOptions,
  toTodoDateInputValue,
  toTodoDateOffsetInputValue,
  toTodoDateTimeLocal,
  toTodoIsoDateTime,
  toTodoIsoDate,
} from "./todoModel";
import { buildMemberBoardOptions, filterTasksByMember, type MemberView } from "./syncModel";
import { todoTexts } from "./todoTexts";
import { wordPackFor, type TodoWordPack } from "./wordPacks";
import { useTodoController } from "./useTodoController";
import "./primitives.css";
import "./todo.css";
import { attachmentFileToPng } from "./attachmentFiles";
import { clipboardIntent } from "./smartArrange";
import { statusBarHint } from "./statusHint";
import type { SmartArrangeEntryTone } from "../../extensions/types";

type HostedTodoPageProps = TodoPageProps & SystemStatusProps & { onOpenAttachment?: (path: string) => Promise<void>; onImportAttachment?: (png: string) => Promise<string>; pendingRequest?: number; smartArrangeAvailable?: boolean; smartArrangeLabel?: string; smartArrangeTone?: SmartArrangeEntryTone; onEnableSmartArrange?: () => void; loginPanel?: ReactNode; onEditorOpenChange?: (open: boolean) => void; onBusyChange?: (busy: boolean) => void; customerLabel?: string };
export type TodoPageComponent = (props: HostedTodoPageProps) => ReactElement;

interface DraftNoticeState {
  tone: "error" | "warn" | "info";
  text: string;
}

function createEmptyDraft(): TodoDraftFields {
  return {
    customerName: "",
    title: "",
    note: "",
    receivedAt: toTodoDateOffsetInputValue(0),
    dueAt: "",
    reminderAt: "",
    category: "",
    attachmentPaths: [],
  };
}

export default function TodoPage({ services, onOpenAttachment, onImportAttachment, systemMessage, onDismissSystemMessage, pendingRequest = 0, quickDueOptions, focusTaskRequest, active = true, refreshRequest = 0, customerSuggestions = [], customerLabel = "来源", smartArrangeAvailable = false, smartArrangeLabel, smartArrangeTone, onEnableSmartArrange, loginPanel, onEditorOpenChange, onBusyChange, syncBoard }: HostedTodoPageProps): ReactElement {
  const wordPack: TodoWordPack = wordPackFor(customerLabel);
  const dueWords = dueWordsFor(wordPack.dueWord);
  const showingLogin = Boolean(loginPanel);
  const { core, state } = useTodoController(services);
  const lastRefresh = useRef(refreshRequest);
  useEffect(() => {
    if (!active || lastRefresh.current === refreshRequest) return;
    lastRefresh.current = refreshRequest;
    void core.loadTasks();
  }, [active, core, refreshRequest]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TodoDraftFields>(() => createEmptyDraft());
  const attachmentPathsRef = useRef<string[]>([]);
  attachmentPathsRef.current = draft.attachmentPaths;
  const [titleError, setTitleError] = useState(false);
  const [recognitionView, setRecognitionView] = useState<TodoRecognitionView>({ kind: "idle" });
  const [notePulse, setNotePulse] = useState(0);
  const [notice, setNotice] = useState<DraftNoticeState | null>(null);
  useEffect(() => {
    if (state.loadError && state.tasks.length > 0) setNotice({ tone: "warn", text: state.loadError });
  }, [state.loadError]);
  const [visibleLimit, setVisibleLimit] = useState(TODO_BATCH_SIZE);
  const [attachmentThumbs, setAttachmentThumbs] = useState<Record<string, string>>({});
  const [deferTaskId, setDeferTaskId] = useState<string | null>(null);
  const [deferCalendarMonth, setDeferCalendarMonth] = useState(() => new Date());
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const [archive, setArchive] = useState(false);
  const [reminderQueue, setReminderQueue] = useState<ReminderDispatch[]>([]);
  const [importingAttachments, setImportingAttachments] = useState(false);
  const importingRef = useRef(false);
  const accountActionsBusy = state.saving || state.recognizing || state.addingAttachment || importingAttachments || Boolean(deferTaskId || deleteTaskId);
  useEffect(() => { onBusyChange?.(accountActionsBusy); }, [accountActionsBusy, onBusyChange]);
  useEffect(() => { onEditorOpenChange?.(dialogOpen); }, [dialogOpen, onEditorOpenChange]);

  // 到点任务提醒：订阅外壳投递事件，去重后进入待处理队列，供应用内卡片稍后提醒/完成/取消。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<ReminderDispatch>("pometodo-reminder-due", ({ payload }) => {
      if (cancelled || !payload?.instanceId) return;
      setReminderQueue(current =>
        current.some(item => item.instanceId === payload.instanceId)
          ? current
          : [...current, payload],
      );
    }).then((off) => { if (!cancelled) unlisten = off; }).catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const dismissReminder = useCallback((instanceId: string) => {
    setReminderQueue(current => current.filter(item => item.instanceId !== instanceId));
  }, []);

  const handleReminderSnooze = useCallback(async (instanceId: string, minutes: number) => {
    const result = await core.snoozeReminder(instanceId, minutes);
    if (!result.ok) setNotice({ tone: "error", text: result.message });
    dismissReminder(instanceId);
  }, [core, dismissReminder]);

  const handleReminderCancel = useCallback(async (instanceId: string) => {
    const result = await core.cancelReminder(instanceId);
    if (!result.ok) setNotice({ tone: "error", text: result.message });
    dismissReminder(instanceId);
  }, [core, dismissReminder]);

  const handleReminderComplete = useCallback(async (taskId: string, instanceId: string) => {
    const result = await core.setTaskStatus(taskId, "completed");
    if (!result.ok) setNotice({ tone: "error", text: result.message });
    dismissReminder(instanceId);
  }, [core, dismissReminder]);

  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const attachmentThumbsRef = useRef<Record<string, string>>({});
  const recognitionSeqRef = useRef(0);
  const lastFocusRequestIdRef = useRef<number | null>(null);

  const renderNow = new Date();
  const renderDay = renderNow.toDateString();
  const searching = Boolean(state.search.trim());
  // 团队成员视角（M10）：成员列表为空时退回全量，「我」在未拿到 memberId 时不收敛。
  const syncMembers: SyncMember[] = syncBoard?.members ?? [];
  const syncMemberId = syncBoard?.memberId ?? null;
  const [memberView, setMemberView] = useState<MemberView>("all");
  useEffect(() => {
    if (syncMembers.length === 0) setMemberView("all");
  }, [syncMembers.length]);
  const memberOptions = useMemo(
    () => buildMemberBoardOptions(state.tasks, syncMembers, syncMemberId),
    [state.tasks, syncMembers, syncMemberId],
  );
  const boardTasks = useMemo(
    () => filterTasksByMember(state.visibleTasks, memberView, syncMemberId),
    [state.visibleTasks, memberView, syncMemberId],
  );
  const displayGroups = useMemo(() => getTodoDisplayGroups(boardTasks, state.status, searching, new Date(renderDay), dueWords), [boardTasks, state.status, searching, renderDay, dueWords]);
  const completedGroups = useMemo(() => getCompletedTodoGroups(boardTasks, new Date(renderDay)), [boardTasks, renderDay]);
  const dueDateShortcuts = useMemo(
    () => parseTodoQuickDueOptions(quickDueOptions ?? ""),
    [quickDueOptions],
  );
  const visiblePlan = useMemo(() => getTodoListSlice(displayGroups.flatMap(group => group.tasks), visibleLimit), [displayGroups, visibleLimit]);
  const statusFilters = useMemo<{ key: TodoFilter; label: string; count: number }[]>(
    () => [
      { key: "today", label: wordPack.todayWord, count: state.counts.today },
      { key: "pending", label: todoTexts.pending, count: state.counts.pending },
      { key: "in_progress", label: todoTexts.inProgress, count: state.counts.in_progress },
      { key: "completed", label: todoTexts.completed, count: state.counts.completed },
    ],
    [state.counts.completed, state.counts.in_progress, state.counts.pending, state.counts.today, wordPack.todayWord],
  );
  const deferTaskTarget = useMemo(
    () => state.tasks.find((task) => task.id === deferTaskId) ?? null,
    [deferTaskId, state.tasks],
  );
  const deleteTaskTarget = useMemo(
    () => state.tasks.find((task) => task.id === deleteTaskId) ?? null,
    [deleteTaskId, state.tasks],
  );

  const closeDialog = useCallback(() => {
    if (core.getState().saving) return;
    recognitionSeqRef.current += 1;
    setDialogOpen(false);
    setTitleError(false);
    setRecognitionView({ kind: "idle" });
    // 新增态取消=放弃本次编辑：清空草稿（含附件），避免残留旧图被下次识别误用。
    if (!editingId) setDraft(createEmptyDraft());
  }, [core, editingId]);

  const lastPendingRequest = useRef(0);
  useEffect(() => {
    if (!active || showingLogin || !pendingRequest || lastPendingRequest.current === pendingRequest) return;
    lastPendingRequest.current = pendingRequest;
    closeDialog();
    setArchive(false);
    core.setSearch("");
    core.setStatus("pending");
  }, [active, showingLogin, pendingRequest, closeDialog, core]);

  const applyRecognition = useCallback((recognized: TodoRecognitionDraft) => {
    setDraft((current) => {
      const next = applyTodoRecognitionDraft(current, recognized);
      return {
        ...next,
        receivedAt: next.receivedAt ? toTodoDateInputValue(next.receivedAt) : current.receivedAt,
        dueAt: toTodoDateInputValue(next.dueAt),
      };
    });
    setTitleError(false);
  }, []);

  /** 识别剪贴板；表单关闭或切换后，较早的异步结果不再覆盖新表单。 */
  const runRecognize = useCallback(async () => {
    if (!smartArrangeAvailable || importingRef.current || core.getState().addingAttachment || core.getState().recognizing || core.getState().saving) return;
    const seq = recognitionSeqRef.current + 1;
    recognitionSeqRef.current = seq;
    setRecognitionView({ kind: "loading" });

    // 附件箱有截图时优先识别附件（用户拖入的图），否则读剪贴板。
    const attachmentPaths = attachmentPathsRef.current;
    const latestAttachment = attachmentPaths.length > 0 ? attachmentPaths[attachmentPaths.length - 1] : null;
    const outcome = latestAttachment ? await core.recognizeAttachment(latestAttachment) : await core.recognizeClipboard();
    if (!outcome || seq !== recognitionSeqRef.current) return;

    if (outcome.kind === "ai") {
      applyRecognition(outcome.draft);
      if (outcome.draft.note) setNotePulse(value => value + 1);
      setRecognitionView({ kind: "ai" });
      setNotice(outcome.message ? { tone: "info", text: outcome.message } : null);
      return;
    }
    if (outcome.kind === "local") {
      applyRecognition({ attachmentPaths: outcome.draft.attachmentPaths, note: outcome.draft.note });
      if (outcome.draft.note) setNotePulse(value => value + 1);
      setRecognitionView({ kind: "local", message: outcome.message });
      setNotice({ tone: "warn", text: outcome.message });
      return;
    }
    if (outcome.kind === "empty") {
      setRecognitionView({ kind: "empty", message: outcome.message });
      setNotice({ tone: "info", text: outcome.message || todoTexts.noClipboardContent });
      return;
    }
    setRecognitionView({ kind: "error", message: outcome.message });
    setNotice({ tone: "warn", text: outcome.message || todoTexts.recognizeClipboardFailure });
    try {
      const text = await navigator.clipboard?.readText?.();
      if (text && text.trim()) {
        const fb = await core.arrangeText(text);
        if (fb && seq === recognitionSeqRef.current && fb.kind === "ai") {
          applyRecognition(fb.draft);
          if (fb.draft.note) setNotePulse(v => v + 1);
          setRecognitionView({ kind: "ai" });
        }
      }
    } catch {}
  }, [applyRecognition, core, smartArrangeAvailable]);

  const runArrangeText = useCallback(async (text: string) => {
    if (!smartArrangeAvailable || core.getState().recognizing || core.getState().saving) return;
    const seq = recognitionSeqRef.current + 1;
    recognitionSeqRef.current = seq;
    setRecognitionView({ kind: "loading" });
    const outcome = await core.arrangeText(text);
    if (!outcome || seq !== recognitionSeqRef.current) return;
    if (outcome.kind === "ai") {
      applyRecognition(outcome.draft);
      if (outcome.draft.note) setNotePulse(v => v + 1);
      setRecognitionView({ kind: "ai" });
      setNotice(outcome.message ? { tone: "info", text: outcome.message } : null);
      return;
    }
    setRecognitionView({ kind: "error", message: outcome.message });
    setNotice({ tone: "warn", text: outcome.message || todoTexts.recognizeClipboardFailure });
  }, [applyRecognition, core, smartArrangeAvailable]);

  const openCreateDialog = useCallback(
    (options?: { recognizeClipboard?: boolean }) => {
      if (core.getState().saving || core.getState().recognizing || core.getState().addingAttachment || importingRef.current) return;
      recognitionSeqRef.current += 1;
      setNotice(null);
      setEditingId(null);
      setDraft(createEmptyDraft());
      setTitleError(false);
      setRecognitionView({ kind: "idle" });
      setDialogOpen(true);
      if (options?.recognizeClipboard) {
        window.setTimeout(() => {
          void runRecognize();
        }, 0);
      }
    },
    [core, runRecognize],
  );

  // 卡片"登录体验智能整理"：打开新增表单并在其中原位显示扫码；表单已开时保留草稿直接切换。
  useEffect(() => {
    if (!loginPanel || dialogOpen) return;
    openCreateDialog();
  }, [loginPanel, dialogOpen, openCreateDialog]);

  const openEditDialog = useCallback((task: TodoTask) => {
    if (core.getState().saving || core.getState().recognizing || core.getState().addingAttachment || importingRef.current) return;
    recognitionSeqRef.current += 1;
    setEditingId(task.id);
    setDraft({
      customerName: task.customerName,
      title: task.title,
      note: task.note,
      receivedAt: toTodoDateInputValue(task.receivedAt),
      dueAt: toTodoDateInputValue(task.dueAt),
      reminderAt: toTodoDateTimeLocal(task.reminderAt ?? null),
      category: task.category ?? "",
      attachmentPaths: task.attachmentPaths,
    });
    setTitleError(false);
    setRecognitionView({ kind: "idle" });
    setDialogOpen(true);
  }, [core]);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisibleLimit(TODO_BATCH_SIZE), 0);
    return () => window.clearTimeout(timer);
  }, [state.search, state.status]);

  const loadMoreTasks = useCallback(() => {
    setVisibleLimit((value) => Math.min(state.visibleTasks.length, value + TODO_BATCH_SIZE));
  }, [state.visibleTasks.length]);

  useEffect(() => {
    if (!visiblePlan.hasMore) return;

    const root = listRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMoreTasks();
      },
      { root, rootMargin: "120px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreTasks, visiblePlan.hasMore]);

  const openAttachment = useCallback(
    async (path: string) => {
      if (!path) return;
      try {
        if (!onOpenAttachment) throw new Error("请在桌面软件中打开截图");
        await onOpenAttachment(path);
      } catch (error) {
        setNotice({ tone: "warn", text: error instanceof Error ? error.message : "无法打开系统看图软件" });
      }
    },
    [onOpenAttachment],
  );

  const removeDialogAttachment = useCallback((path: string) => {
    setDraft((current) => ({
      ...current,
      attachmentPaths: current.attachmentPaths.filter((item) => item !== path),
    }));
    setAttachmentThumbs((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);

  const loadAttachmentThumbnails = useCallback(
    async (paths: string[]) => {
      const missingPaths = paths.filter((path) => !attachmentThumbsRef.current[path]);
      if (missingPaths.length === 0) return;

      const entries = await Promise.all(
        missingPaths.map(async (path) => {
          try {
            const dataUrl = await core.getAttachmentDataUrl(path);
            return [path, dataUrl] as const;
          } catch (error) {
            console.error("Failed to load todo attachment thumbnail:", error);
            return null;
          }
        }),
      );

      setAttachmentThumbs((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (entry) next[entry[0]] = entry[1];
        }
        return next;
      });
    },
    [core],
  );

  useEffect(() => {
    attachmentThumbsRef.current = attachmentThumbs;
  }, [attachmentThumbs]);

  useEffect(() => {
    if (dialogOpen && draft.attachmentPaths.length > 0) {
      const timer = window.setTimeout(() => loadAttachmentThumbnails(draft.attachmentPaths), 0);
      return () => window.clearTimeout(timer);
    }
  }, [dialogOpen, draft.attachmentPaths, loadAttachmentThumbnails]);

  const addDialogAttachment = useCallback(async () => {
    if (importingRef.current || core.getState().saving || core.getState().recognizing) return;
    const seq = recognitionSeqRef.current;
    const result = await core.saveClipboardAttachment();
    if (seq !== recognitionSeqRef.current) return;
    if (!result.ok) {
      setNotice({ tone: "warn", text: result.message });
      return;
    }
    if (!result.path) {
      setNotice({ tone: "warn", text: todoTexts.clipboardNoImage });
      return;
    }
    const path = result.path;
    setDraft((current) =>
      current.attachmentPaths.includes(path)
        ? current
        : { ...current, attachmentPaths: [...current.attachmentPaths, path] },
    );
  }, [core]);

  const importDialogAttachments = async (files: File[]) => {
    if (importingRef.current || core.getState().addingAttachment || core.getState().saving || !files.length) return;
    if (!onImportAttachment) { setNotice({ tone: "warn", text: "请在桌面客户端中添加本地图片" }); return; }
    const seq = recognitionSeqRef.current;
    importingRef.current = true;
    setImportingAttachments(true);
    let added = 0;
    try {
      for (const file of files) {
        if (seq !== recognitionSeqRef.current) break;
        const png = await attachmentFileToPng(file);
        if (seq !== recognitionSeqRef.current) break;
        const path = await onImportAttachment(png);
        if (seq !== recognitionSeqRef.current) break;
        setDraft(current => ({ ...current, attachmentPaths: [...current.attachmentPaths, path] }));
        added++;
      }
      if (seq === recognitionSeqRef.current) setNotice({ tone: "info", text: `已添加 ${added} 张截图` });
    } catch (error) {
      if (seq === recognitionSeqRef.current) setNotice({ tone: "warn", text: `${added ? `已添加 ${added} 张；` : ""}${error instanceof Error ? error.message : "图片添加失败，请重试"}` });
    } finally { importingRef.current = false; setImportingAttachments(false); }
  };

  const saveTask = async () => {
    if (importingRef.current || core.getState().addingAttachment || core.getState().recognizing) return;
    const customerName = draft.customerName.trim();
    const title = draft.title.trim();
    // 客户为选填：不填留空；仅任务内容缺失时红框提示。
    if (!title) {
      setTitleError(true);
      return;
    }

    const payload = {
      customerName,
      title,
      note: draft.note.trim(),
      receivedAt: toTodoIsoDate(draft.receivedAt) ?? new Date().toISOString(),
      dueAt: toTodoIsoDate(draft.dueAt),
      category: draft.category.trim(),
      attachmentPaths: draft.attachmentPaths,
    };

    const result = editingId
      ? await core.updateTask(editingId, payload)
      : await core.createTask(payload);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.message });
      return;
    }

    // 提醒时间独立于正文保存：编辑态在更新成功后同步设置或清除。
    if (editingId) {
      const reminderResult = await core.setTaskReminder(
        editingId,
        toTodoIsoDateTime(draft.reminderAt),
      );
      if (!reminderResult.ok) {
        setNotice({ tone: "error", text: reminderResult.message });
      }
    }

    closeDialog();
  };

  const updateTaskDueDate = async (task: TodoTask, dateValue: string) => {
    const [year, month, day] = dateValue.split("-").map(Number);
    if (!year || !month || !day) return;

    const base = task.dueAt ? new Date(task.dueAt) : new Date();
    const nextDueAt = new Date(year, month - 1, day);
    nextDueAt.setHours(
      Number.isNaN(base.getTime()) ? 0 : base.getHours(),
      Number.isNaN(base.getTime()) ? 0 : base.getMinutes(),
      0,
      0,
    );

    const result = await core.updateTask(task.id, {
      customerName: task.customerName,
      title: task.title,
      note: task.note,
      receivedAt: task.receivedAt,
      dueAt: nextDueAt.toISOString(),
      attachmentPaths: task.attachmentPaths,
    });
    if (!result.ok) {
      setNotice({ tone: "error", text: result.message });
      return;
    }
    setDeferTaskId(null);
  };

  const openDeferDatePicker = useCallback((task: TodoTask) => {
    const selectedDate = task.dueAt ? new Date(task.dueAt) : new Date();
    const monthDate = Number.isNaN(selectedDate.getTime()) ? new Date() : selectedDate;
    setDeferCalendarMonth(new Date(monthDate.getFullYear(), monthDate.getMonth(), 1));
    setDeferTaskId(task.id);
  }, []);

  const handleSetUrgent = useCallback(
    async (task: TodoTask, urgent: boolean) => {
      const result = await core.setTaskUrgent(task.id, urgent);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.message });
      }
    },
    [core],
  );

  const handleSetAssignee = useCallback(
    async (task: TodoTask, assignee: string | null) => {
      if (!syncBoard?.setAssignee) return;
      const ok = await syncBoard.setAssignee(task.id, assignee);
      if (!ok) setNotice({ tone: "error", text: "指派失败，请稍后重试" });
    },
    [syncBoard],
  );

  const handleArchive = useCallback(
    async (task: TodoTask) => {
      const result = await core.archiveTask(task.id);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.message });
      }
    },
    [core],
  );

  const handleUnarchive = useCallback(
    async (task: TodoTask) => {
      const result = await core.unarchiveTask(task.id);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.message });
      }
    },
    [core],
  );

  const runWorkflowAction = useCallback(
    async (task: TodoTask, action: TodoWorkflowAction) => {
      if (action === "defer") {
        openDeferDatePicker(task);
        return;
      }
      const nextStatus = TODO_ACTION_STATUS[action];
      if (!nextStatus) return;
      const result = await core.setTaskStatus(task.id, nextStatus);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.message });
      }
    },
    [core, openDeferDatePicker],
  );

  const confirmDelete = async () => {
    if (!deleteTaskTarget) return;
    const result = await core.deleteTask(deleteTaskTarget.id);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.message });
      return;
    }
    setDeleteTaskId(null);
  };

  const openDeleteFromDialog = () => {
    if (!editingId || core.getState().saving) return;
    setDeleteTaskId(editingId);
    setDialogOpen(false);
  };

  // 原生事件由宿主接收后传入 focusTaskRequest：定位已有任务，不重复创建。
  useEffect(() => {
    if (!active || showingLogin || !focusTaskRequest) return;
    if (lastFocusRequestIdRef.current === focusTaskRequest.requestId) return;
    lastFocusRequestIdRef.current = focusTaskRequest.requestId;

    let cancelled = false;
    void (async () => {
      const task = await core.ensureTask(focusTaskRequest.taskId);
      if (cancelled || !task) return;
      core.setSearch("");
      // 已完成任务切到已完成筛选，不会被切到未完成筛选。
      core.setStatus(task.status);
      setArchive(task.status === "completed" && getCompletedTodoGroups([task]).archived.length > 0);
      closeDialog();
      setHighlightedTaskId(task.id);
    })();

    return () => {
      cancelled = true;
    };
  }, [active, showingLogin, closeDialog, core, focusTaskRequest]);

  useEffect(() => {
    if (!highlightedTaskId || !listRef.current) return;

    const timer = window.setTimeout(() => {
      const target = listRef.current?.querySelector<HTMLElement>(
        `[data-task-id="${highlightedTaskId}"]`,
      );
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);

    const clearTimer = window.setTimeout(() => {
      setHighlightedTaskId(null);
    }, 1800);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clearTimer);
    };
  }, [highlightedTaskId, visiblePlan.items]);

  // Escape 自内向外关闭弹层。
  useEffect(() => {
    if (!active || showingLogin || (!dialogOpen && !deferTaskId && !deleteTaskId)) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (deferTaskId) {
        setDeferTaskId(null);
        return;
      }
      if (deleteTaskId) {
        setDeleteTaskId(null);
        return;
      }
      closeDialog();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active, showingLogin, closeDialog, deleteTaskId, deferTaskId, dialogOpen]);

  // Ctrl+V：非输入区域快速识别；输入框保留正常粘贴，避免误触 AI。
  useEffect(() => {
    if (!active || showingLogin) return;
    const handleTodoClipboardShortcut = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const intent = clipboardIntent({
        editable: Boolean(target?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")),
        available: smartArrangeAvailable,
        busy: Boolean(deferTaskId || deleteTaskId || core.getState().recognizing || core.getState().saving || core.getState().addingAttachment || importingRef.current),
      });
      if (intent === "native") return;
      event.preventDefault();
      if (intent === "ignore") return;
      if (!dialogOpen) openCreateDialog();
      if (intent === "arrange") void runRecognize();
      else void addDialogAttachment();
    };

    document.addEventListener("paste", handleTodoClipboardShortcut);
    return () => document.removeEventListener("paste", handleTodoClipboardShortcut);
  }, [
    active,
    showingLogin,
    deleteTaskId,
    deferTaskId,
    dialogOpen,
    smartArrangeAvailable,
    core,
    addDialogAttachment,
    openCreateDialog,
    runRecognize,
    state.recognizing,
  ]);

  const handleCustomerInput = (value: string) => {
    setDraft((current) => ({ ...current, customerName: value }));
  };

  const handleTitleInput = (value: string) => {
    setDraft((current) => ({ ...current, title: value }));
    if (value.trim()) setTitleError(false);
  };

  useEffect(() => {
    if (!active || showingLogin) return;
    const handleNewTask = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      if (!dialogOpen && !deferTaskId && !deleteTaskId) openCreateDialog();
    };
    document.addEventListener("keydown", handleNewTask);
    return () => document.removeEventListener("keydown", handleNewTask);
  }, [active, showingLogin, dialogOpen, deferTaskId, deleteTaskId, openCreateDialog]);

  const renderTaskCard = (task: TodoTask, index: number) => <TodoCard
    key={task.id} task={task} enterIndex={index} dueInfo={getTodoDueInfo(task, renderNow, dueWords)} wordPack={wordPack}
    todayContext={!searching && state.status === "today"}
    archived={task.status === "completed" && Boolean(task.archivedAt)}
    highlighted={highlightedTaskId === task.id}
    busy={state.busyTaskIds.includes(task.id) || state.deletingTaskId === task.id}
    onOpenEdit={openEditDialog}
    onSetUrgent={(target, urgent) => void handleSetUrgent(target, urgent)}
    onOpenDeferPicker={openDeferDatePicker}
    onArchive={(target) => void handleArchive(target)}
    onUnarchive={(target) => void handleUnarchive(target)}
    onWorkflowAction={(target, action) => void runWorkflowAction(target, action)}
    onOpenAttachment={(path) => void openAttachment(path)}
    members={syncMembers}
    assigneeDisabled={!syncMemberId}
    onSetAssignee={(target, assignee) => void handleSetAssignee(target, assignee)}
  />;
  const heading = dialogOpen ? editingId ? "编辑待办" : "新增待办" : searching ? "搜索结果" : archive && state.status === "completed" ? "归档" : statusFilters.find(item => item.key === state.status)?.label;
  const editor = <TodoDialog
    editing={editingId !== null} draft={draft}
    titleError={titleError} recognitionView={recognitionView} notePulse={notePulse}
    quickDueOptions={dueDateShortcuts} customerSuggestions={customerSuggestions} customerLabel={customerLabel}
    attachmentThumbs={attachmentThumbs} saving={state.saving} addingAttachment={state.addingAttachment || importingAttachments}
    onCustomerInput={handleCustomerInput} onTitleInput={handleTitleInput}
    onNoteInput={(value) => setDraft((current) => ({ ...current, note: value }))}
    onReceivedInput={(value) => setDraft((current) => ({ ...current, receivedAt: value }))}
    onDueInput={(value) => setDraft((current) => ({ ...current, dueAt: value }))}
    onReminderInput={(value) => setDraft((current) => ({ ...current, reminderAt: value }))}
    onCategoryInput={(value) => setDraft((current) => ({ ...current, category: value }))}
    onClose={closeDialog} onSave={() => void saveTask()} onDelete={openDeleteFromDialog}
    smartArrangeAvailable={smartArrangeAvailable}
    smartArrangeLabel={smartArrangeLabel}
    smartArrangeTone={smartArrangeTone}
    accountView={loginPanel}
    onRecognize={() => { if (smartArrangeAvailable) void runRecognize(); else onEnableSmartArrange?.(); }}
    onVoiceArrange={(text) => { if (smartArrangeAvailable) void runArrangeText(text); }}
    onImportAttachments={(files) => void importDialogAttachments(files)}
    onRemoveAttachment={removeDialogAttachment} onOpenAttachment={(path) => void openAttachment(path)}
  />;

  return (
    <div className="pometodo-todo todo-page">
      <div className="todo-page-header">
        <div className="todo-heading-row">
          <div><h1>{heading}</h1><p>{renderNow.toLocaleDateString("zh-CN", {year:"numeric",month:"long",day:"numeric",weekday:"long"})}</p></div>
          {archive && !searching && state.status === "completed" ? <button className="todo-add-btn" type="button" onClick={() => setArchive(false)}><span className="page-action-label">返回</span></button> :
            <button className="todo-add-btn" type="button" onClick={() => openCreateDialog()} aria-label={todoTexts.newTask}>{todoIcons.add}<span className="page-action-label">新增</span></button>}
        </div>
      <div className="page-search">
        <SearchInput
          placeholder={todoTexts.search}
          value={state.search}
          onChange={(value) => { if (dialogOpen) closeDialog(); core.setSearch(value); }}
        />
      </div>

      <div className="todo-toolbar">
        <div className="todo-filter-scroll" role="tablist" aria-label="任务分类">
          {statusFilters.map((item) => (
            <button
              key={item.key}
              className={`todo-filter-tab ${!searching && state.status === item.key ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={!searching && state.status === item.key}
              onClick={() => { closeDialog(); setArchive(false); core.setSearch(""); core.setStatus(item.key); }}
              aria-label={`${item.label} ${item.count}`}
            >
              <span>{item.label}</span>
              <span className="todo-chip-count"><span className="todo-control-label">{item.count}</span></span>
            </button>
          ))}
        </div>
      </div>
      {syncMembers.length > 0 && (
        <div className="todo-toolbar todo-member-toolbar">
          <div className="todo-filter-scroll" role="group" aria-label="成员筛选">
            {memberOptions.map((option) => (
              <button
                key={option.key}
                className={`todo-filter-tab todo-member-tab${memberView === option.key ? " active" : ""}`}
                type="button"
                aria-pressed={memberView === option.key}
                onClick={() => setMemberView(option.key)}
                title={`${option.label}：待办 ${option.count.pending} · 进行中 ${option.count.in_progress} · 已完成 ${option.count.completed}`}
                aria-label={`${option.label}，待办 ${option.count.pending}，进行中 ${option.count.in_progress}，已完成 ${option.count.completed}`}
              >
                <span>{option.label}</span>
                <span className="todo-chip-count">
                  <span className="todo-control-label">{option.count.pending}/{option.count.in_progress}/{option.count.completed}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      </div>

      {dialogOpen ? editor : state.loading && state.tasks.length === 0 ? (
        <div className="todo-list">
          {[1, 2, 3].map((item) => (
            <div key={item} className="notification skeleton">
              <div className="notibar" />
              <div className="noticontent">
                <div className="notititle">
                  <div className="skeleton-line short" />
                </div>
                <div className="notibody">
                  <div className="skeleton-line" style={{ width: `${58 + item * 8}%` }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : state.loadError && state.tasks.length === 0 ? (
        <div className="page-empty-compact">
          <div className="empty-icon-compact">{todoIcons.todo}</div>
          <span>{state.loadError}</span>
          <button className="todo-lite-button" type="button" onClick={() => void core.loadTasks()}>
            {todoTexts.retry}
          </button>
        </div>
      ) : !searching && state.status === "completed" ? (
        <CompletedList key={archive ? "archive" : "recent"} {...completedGroups} archive={archive} onArchive={() => setArchive(true)} renderTask={renderTaskCard} focusTaskId={highlightedTaskId} listRef={listRef} />
      ) : boardTasks.length === 0 ? (
        <div className="page-empty-compact">
          <div className="empty-icon-compact">{todoIcons.todo}</div>
          <span>{searching ? "没有找到匹配的任务" : memberView !== "all" ? "该视角下暂无任务" : todoTexts.empty}</span>
        </div>
      ) : (
        <div className="todo-list" ref={listRef}>
          {visiblePlan.items.map((task, index) => (
            <Fragment key={task.id}>
            {displayGroups.filter(group => group.label && group.tasks[0]?.id === task.id).map(group => <h2 className={`todo-group-title tone-${group.tone}`} key={group.key}>
              <b aria-hidden="true" />{group.label}<span>{group.tasks.length}</span><i />
            </h2>)}
            {renderTaskCard(task, index)}
            </Fragment>
          ))}
          {visiblePlan.hasMore && (
            <>
              <div ref={sentinelRef} className="todo-list-sentinel" />
              <button className="clipboard-load-more" type="button" onClick={loadMoreTasks}>
                {todoTexts.loadMore(Math.min(TODO_BATCH_SIZE, visiblePlan.hiddenCount))}
              </button>
            </>
          )}
        </div>
      )}

      <StatusBar className="todo-statusbar" hint={statusBarHint({ dialogOpen, showingLogin, recognizing: state.recognizing, smartArrangeAvailable })}
        message={systemMessage ?? notice} onDismiss={() => { if (systemMessage) onDismissSystemMessage?.(); else setNotice(null); }}>
          {searching ? <span className="todo-search-summary" title={`找到 ${state.visibleTasks.length} 条包含「${state.search.trim()}」的任务`}>
            找到 {state.visibleTasks.length} 条包含「{state.search.trim()}」的任务
          </span> : <>
            <span className="todo-status-count pending">未完成 {state.counts.pending}</span>
            <span className="todo-status-count in-progress">进行中 {state.counts.in_progress}</span>
            <span className="todo-status-count completed">已完成 {state.counts.completed}</span>
          </>}
      </StatusBar>

      {deferTaskTarget && (
        <div className="dialog-overlay" onClick={() => setDeferTaskId(null)}>
          <div
            className="dialog-content todo-lite-dialog todo-popover-dialog todo-calendar-only-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <TodoCalendar
              className="todo-defer-calendar"
              month={deferCalendarMonth}
              onShiftMonth={(offset) => setDeferCalendarMonth((date) => shiftCalendarMonth(date, offset))}
              selectedDate={parseTodoDialogDateValue(toTodoDateInputValue(deferTaskTarget.dueAt))}
              onSelect={(value) => {
                setDeferTaskId(null);
                void updateTaskDueDate(deferTaskTarget, value);
              }}
            />
          </div>
        </div>
      )}

      {deleteTaskTarget && (
        <div className="dialog-overlay" onMouseDown={() => setDeleteTaskId(null)}>
          <div
            className="dialog-content todo-lite-dialog todo-confirm-dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="todo-confirm-message">{todoTexts.confirmDeleteMessage}</p>
            <div className="todo-lite-actions">
              <button className="todo-lite-button" type="button" onClick={() => setDeleteTaskId(null)}>
                {todoTexts.cancel}
              </button>
              <button
                className="todo-lite-button danger"
                type="button"
                onClick={() => void confirmDelete()}
                disabled={state.deletingTaskId !== null}
              >
                {state.deletingTaskId !== null ? todoTexts.deletingLabel : todoTexts.delete}
              </button>
            </div>
          </div>
        </div>
      )}

      {reminderQueue.length > 0 && (
        <div className="todo-reminder-stack">
          {reminderQueue.map((item) => (
            <div className="todo-reminder-card" key={item.instanceId}>
              <div className="todo-reminder-head">
                <span className="todo-reminder-dot" aria-hidden="true" />
                <div className="todo-reminder-meta">
                  <strong className="todo-reminder-title">{item.title}</strong>
                  <span className="todo-reminder-customer">{item.customerName}</span>
                </div>
                <button className="todo-reminder-close" type="button" onClick={() => dismissReminder(item.instanceId)} aria-label="关闭">
                  {todoIcons.close}
                </button>
              </div>
              <div className="todo-reminder-actions">
                <button className="todo-reminder-btn" type="button" onClick={() => void handleReminderComplete(item.taskId, item.instanceId)}>完成</button>
                <button className="todo-reminder-btn" type="button" onClick={() => void handleReminderSnooze(item.instanceId, 10)}>10 分钟后</button>
                <button className="todo-reminder-btn" type="button" onClick={() => void handleReminderCancel(item.instanceId)}>取消提醒</button>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
