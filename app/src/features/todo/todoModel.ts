/**
 * PomeTodo 待办纯逻辑：筛选、排序、计数、日期展示与识别回填。
 * 提取自 sltool 待办模块；任务、筛选与识别草稿类型来自固定接口，
 * 本模块不再重复定义数据结构，也不包含记账动作与旧数据导入摘要。
 */
import type {
  TodoFilter,
  TodoRecognitionDraft,
  TodoStatus,
  TodoStatusCounts,
  TodoTask,
} from "../../contracts/todo";

export type { TodoFilter, TodoRecognitionDraft, TodoStatus, TodoStatusCounts, TodoTask };

export const TODO_BATCH_SIZE = 10;

export interface TodoQuickDueOption {
  label: string;
  days: number;
}

export const DEFAULT_TODO_QUICK_DUE_OPTIONS: TodoQuickDueOption[] = [
  { label: "今天", days: 0 },
  { label: "明天", days: 1 },
  { label: "后天", days: 2 },
  { label: "+3天", days: 3 },
  { label: "+7天", days: 7 },
];

export interface TodoListSlice {
  items: TodoTask[];
  hasMore: boolean;
  hiddenCount: number;
}

export interface TodoDueInfo {
  tone: "overdue" | "today" | "upcoming" | "normal" | "completed";
  label: string;
}

/** 完成/交付动词词包；工作场景为「交付」，生活/学习为「完成」。 */
export interface TodoDueWords {
  today: string;
  tomorrow: string;
  onTime: string;
  late: (days: number) => string;
  unscheduled: string;
  clear: string;
  expiringToday: string;
}

export function dueWordsFor(dueWord: "交付" | "完成"): TodoDueWords {
  const todayWord = dueWord === "交付" ? "今日" : "今天";
  return {
    today: `${todayWord}${dueWord}`,
    tomorrow: `明天${dueWord}`,
    onTime: `按时${dueWord}`,
    late: (days) => `逾期 ${days} 天${dueWord}`,
    unscheduled: `未设${dueWord}日期`,
    clear: `不设${dueWord}日期`,
    expiringToday: `${todayWord}到期`,
  };
}

const DEFAULT_DUE_WORDS = dueWordsFor("交付");

export type TodoWorkflowAction =
  | "defer"
  | "start"
  | "wait"
  | "resume"
  | "rollback"
  | "complete"
  | "restore";

/** 工作流动作对应的目标状态；defer 只改交付日期，不在此表。 */
export const TODO_ACTION_STATUS: Partial<Record<TodoWorkflowAction, TodoStatus>> = {
  start: "in_progress",
  wait: "waiting",
  resume: "pending",
  rollback: "pending",
  complete: "completed",
  restore: "in_progress",
};

/** 新增和编辑弹层的表单字段；日期是表单显示值，保存前再转 ISO。 */
export interface TodoDraftFields {
  customerName: string;
  title: string;
  note: string;
  receivedAt: string;
  dueAt: string;
  /** 提醒时间 datetime-local 表单值（YYYY-MM-DDTHH:mm），空串表示不提醒。 */
  reminderAt: string;
  /** 分类名（自由文本，可空）。 */
  category: string;
  attachmentPaths: string[];
}

const statusRank: Record<TodoStatus, number> = {
  pending: 0,
  in_progress: 1,
  waiting: 2,
  completed: 3,
};

export function getVisibleTodoTasks(tasks: TodoTask[]) {
  return [...tasks].sort((a, b) => {
    if (a.status === "completed" && b.status === "completed") {
      return getCompletedSortTime(b) - getCompletedSortTime(a);
    }

    const aUrgent = a.status !== "completed" && Boolean(a.urgentAt);
    const bUrgent = b.status !== "completed" && Boolean(b.urgentAt);
    if (aUrgent !== bUrgent) return bUrgent ? 1 : -1;
    if (aUrgent && bUrgent) {
      const urgentDiff = Date.parse(b.urgentAt ?? "") - Date.parse(a.urgentAt ?? "");
      if (urgentDiff !== 0) return urgentDiff;
    }

    if (a.status !== "completed" && b.status !== "completed") {
      const aDue = getActiveDueSortTime(a);
      const bDue = getActiveDueSortTime(b);
      if (aDue !== bDue) return aDue - bDue;
      if (Number.isFinite(aDue) && a.status !== b.status) {
        return a.status === "in_progress" ? -1 : 1;
      }
      return getActivitySortTime(b) - getActivitySortTime(a);
    }

    const statusDiff = statusRank[a.status] - statusRank[b.status];
    if (statusDiff !== 0) return statusDiff;
    return Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
  });
}

export function isTodoInToday(task: TodoTask, now = new Date()) {
  if (task.status === "completed") return false;
  if (task.urgentAt) return true;
  if (!task.dueAt) return true;

  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime()) || Number.isNaN(now.getTime())) return true;

  return startOfLocalDay(due) <= startOfLocalDay(now);
}

export function getFilteredTodoTasks(
  tasks: TodoTask[],
  filter: TodoFilter,
  now = new Date(),
) {
  if (filter === "today") {
    return tasks.filter((task) => isTodoInToday(task, now));
  }

  return tasks.filter((task) => task.status === filter);
}

/** 客户、任务内容和备注的大小写不敏感包含匹配。 */
export function matchTodoSearch(task: TodoTask, search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return (
    task.customerName.toLowerCase().includes(query) ||
    task.title.toLowerCase().includes(query) ||
    task.note.toLowerCase().includes(query)
  );
}

export function getTodoStatusCounts(tasks: TodoTask[], now = new Date()): TodoStatusCounts {
  return tasks.reduce<TodoStatusCounts>(
    (counts, task) => {
      if (isTodoInToday(task, now)) {
        counts.today += 1;
      }
      counts[task.status] += 1;
      return counts;
    },
    { today: 0, pending: 0, in_progress: 0, waiting: 0, completed: 0 },
  );
}

export function getTodoListSlice(tasks: TodoTask[], limit = TODO_BATCH_SIZE): TodoListSlice {
  const safeLimit = Math.max(0, limit);
  const items = tasks.slice(0, safeLimit);
  const hiddenCount = Math.max(0, tasks.length - items.length);

  return {
    items,
    hasMore: hiddenCount > 0,
    hiddenCount,
  };
}

export interface TodoDisplayGroup {
  key: string;
  label: string;
  tone: string;
  tasks: TodoTask[];
}

/** 展示分组不改变持久化状态；无日期和未来加急仍保留在今日。 */
export function getTodoDisplayGroups(tasks: TodoTask[], filter: TodoFilter, searching: boolean, now = new Date(), words = DEFAULT_DUE_WORDS): TodoDisplayGroup[] {
  if (searching) {
    const completed = getCompletedTodoGroups(tasks, now);
    return [
      { key: "pending", label: "未完成", tone: "today", tasks: tasks.filter(task => task.status === "pending") },
      { key: "in_progress", label: "进行中", tone: "upcoming", tasks: tasks.filter(task => task.status === "in_progress") },
      { key: "recent", label: "最近已完成", tone: "normal", tasks: completed.recent.flatMap(group => group.tasks) },
      { key: "archived", label: "归档已完成", tone: "normal", tasks: completed.archived.flatMap(group => group.tasks) },
    ].filter(group => group.tasks.length);
  }
  if (filter !== "today") return [{ key: filter, label: "", tone: "normal", tasks }];
  const day = startOfLocalDay(now);
  const keyFor = (task: TodoTask) => {
    const due = getActiveDueSortTime(task);
    if (!Number.isFinite(due)) return "unscheduled";
    if (due < day) return "overdue";
    if (due === day) return task.status === "in_progress" ? "progress" : "pending";
    return "urgent";
  };
  return [
    { key: "overdue", label: "已逾期", tone: "overdue" },
    { key: "progress", label: `${words.expiringToday} · 进行中`, tone: "upcoming" },
    { key: "pending", label: `${words.expiringToday} · 未完成`, tone: "today" },
    { key: "urgent", label: "加急", tone: "overdue" },
    { key: "unscheduled", label: words.unscheduled, tone: "normal" },
  ].map(group => ({ ...group, tasks: tasks.filter(task => keyFor(task) === group.key) })).filter(group => group.tasks.length);
}

/** 完成记录：最近七天按完成日期分组；更早记录与手动归档（archivedAt）进入归档桶。 */
export function getCompletedTodoGroups(tasks: TodoTask[], now = new Date()) {
  const cutoff = startOfLocalDay(addLocalDays(now, -6));
  const groups = new Map<string, TodoDisplayGroup>();
  const manuallyArchived: TodoTask[] = [];
  for (const task of getVisibleTodoTasks(tasks.filter(item => item.status === "completed"))) {
    if (task.archivedAt) {
      manuallyArchived.push(task);
      continue;
    }
    const date = new Date(getCompletedSortTime(task));
    const key = toLocalDateString(date);
    const days = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / 86400000);
    const label = days === 0 ? "今天" : days === 1 ? "昨天" : `${date.getMonth() + 1}月${date.getDate()}日`;
    if (!groups.has(key)) groups.set(key, { key, label, tone: "normal", tasks: [] });
    groups.get(key)!.tasks.push(task);
  }
  const all = [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
  const recent = all.filter(group => startOfLocalDay(new Date(`${group.key}T00:00:00`)) >= cutoff);
  const archived = all.filter(group => startOfLocalDay(new Date(`${group.key}T00:00:00`)) < cutoff);
  if (manuallyArchived.length > 0) {
    archived.push({ key: "manual-archive", label: "手动归档", tone: "normal", tasks: manuallyArchived });
  }
  return { recent, archived };
}

export function shouldShowTodoNote(task: TodoTask) {
  return task.note.trim().length > 0;
}

export function normalizeTodoQuickDueOptions(value: unknown): TodoQuickDueOption[] {
  if (!Array.isArray(value)) return DEFAULT_TODO_QUICK_DUE_OPTIONS;

  const normalized = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      const label =
        "label" in item && typeof item.label === "string" ? item.label.trim() : "";
      const days =
        "days" in item && typeof item.days === "number" ? Math.trunc(item.days) : Number.NaN;

      if (!label || Number.isNaN(days) || days < 0 || days > 365) return null;
      return { label, days };
    })
    .filter((item): item is TodoQuickDueOption => item !== null)
    .slice(0, 8);

  return normalized.length > 0 ? normalized : DEFAULT_TODO_QUICK_DUE_OPTIONS;
}

export function parseTodoQuickDueOptions(raw: string): TodoQuickDueOption[] {
  try {
    return normalizeTodoQuickDueOptions(JSON.parse(raw));
  } catch {
    return DEFAULT_TODO_QUICK_DUE_OPTIONS;
  }
}

export function serializeTodoQuickDueOptions(options: TodoQuickDueOption[]) {
  return JSON.stringify(normalizeTodoQuickDueOptions(options));
}

export function getTodoWorkflowActions(task: TodoTask): TodoWorkflowAction[] {
  if (task.status === "pending") return ["start"];
  if (task.status === "in_progress") return ["wait", "rollback", "complete"];
  if (task.status === "waiting") return ["resume", "complete"];
  return ["restore"];
}

export interface TodoDeferOption {
  key: "tomorrow" | "day_after_tomorrow" | "next_monday";
  label: string;
  dateLabel: string;
  date: string;
}

export function getTodoDeferOptions(now = new Date()): TodoDeferOption[] {
  const tomorrow = addLocalDays(now, 1);
  const dayAfterTomorrow = addLocalDays(now, 2);
  const nextMonday = getNextLocalMonday(now);

  return [
    createDeferOption("tomorrow", "明天", tomorrow),
    createDeferOption("day_after_tomorrow", "后天", dayAfterTomorrow),
    createDeferOption("next_monday", "下周一", nextMonday),
  ];
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function parseTime(value: string | null | undefined) {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function getActivitySortTime(task: TodoTask) {
  const updatedAt = parseTime(task.updatedAt);
  if (!Number.isNaN(updatedAt)) return updatedAt;
  const receivedAt = parseTime(task.receivedAt);
  return Number.isNaN(receivedAt) ? 0 : receivedAt;
}

function getCompletedSortTime(task: TodoTask) {
  const completedAt = parseTime(task.completedAt);
  if (!Number.isNaN(completedAt)) return completedAt;
  return getActivitySortTime(task);
}

function getActiveDueSortTime(task: TodoTask) {
  if (!task.dueAt) return Number.POSITIVE_INFINITY;
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return Number.POSITIVE_INFINITY;
  return startOfLocalDay(due);
}

function addLocalDays(value: Date, days: number) {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  date.setDate(date.getDate() + days);
  return date;
}

function getNextLocalMonday(value: Date) {
  const day = value.getDay();
  const daysUntilNextMonday = ((8 - day) % 7) || 7;
  return addLocalDays(value, daysUntilNextMonday);
}

function createDeferOption(key: TodoDeferOption["key"], label: string, date: Date): TodoDeferOption {
  return {
    key,
    label,
    dateLabel: `${date.getMonth() + 1}月${date.getDate()}日`,
    date: toLocalDateString(date),
  };
}

function toLocalDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getTodoDueInfo(task: TodoTask, now = new Date(), words = DEFAULT_DUE_WORDS): TodoDueInfo | null {
  if (!task.dueAt) return task.status === "completed" ? { tone: "normal", label: "已完成" } : null;

  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime()) || Number.isNaN(now.getTime())) return null;

  if (task.status === "completed") {
    const completed = new Date(task.completedAt ?? "");
    if (Number.isNaN(completed.getTime())) return { tone: "normal", label: "已完成" };
    const late = Math.round((startOfLocalDay(completed) - startOfLocalDay(due)) / 86400000);
    return late > 0 ? { tone: "overdue", label: words.late(late) } : { tone: "completed", label: words.onTime };
  }

  const daysUntilDue = Math.round((startOfLocalDay(due) - startOfLocalDay(now)) / 86400000);

  if (daysUntilDue < 0) {
    return {
      tone: "overdue",
      label: `逾期 ${Math.abs(daysUntilDue)} 天`,
    };
  }

  if (daysUntilDue === 0) {
    return {
      tone: "today",
      label: words.today,
    };
  }

  return {
    tone: daysUntilDue === 1 ? "today" : daysUntilDue <= 3 ? "upcoming" : "normal",
    label: daysUntilDue === 1 ? words.tomorrow : `${due.getMonth() + 1}月${due.getDate()}日`,
  };
}

export function formatTodoReceivedLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return `收 ${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 表单显示值（YYYY-MM-DD）转 ISO；空串返回 null，允许保存无交付日期的任务。 */
export function toTodoIsoDate(value: string) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day).toISOString();
}

/** 时间戳转本地表单日期；已有日历日期保持原值，无效或空值返回空串。 */
export function toTodoDateInputValue(value: string | null) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const calendarDate = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(calendarDate.getTime()) && calendarDate.toISOString().slice(0, 10) === value
      ? value
      : "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function toTodoDateOffsetInputValue(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toTodoDateInputValue(date.toISOString());
}

/** ISO 时间戳转本地 datetime-local（YYYY-MM-DDTHH:mm）；空/无效返回空串。 */
export function toTodoDateTimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** datetime-local 转 ISO；空串返回 null，无效返回 null。 */
export function toTodoIsoDateTime(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseTodoDialogDateValue(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTodoDialogDateDisplay(value: string) {
  const date = parseTodoDialogDateValue(value);
  if (!date) return "";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}/${month}/${day}`;
}

function cleanRecognizedText(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTodoRecognitionDueAt(value: string | null | undefined) {
  const text = cleanRecognizedText(value);
  if (!text) return "";
  // 保留 RFC3339 的时刻含义，随后由表单按本地日历显示；不能直接截掉时区。
  if (/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }

  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2}))?$/);
  if (!match) return "";

  const [, year, month, day, hour = "00", minute = "00"] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

export function applyTodoRecognitionDraft(
  current: TodoDraftFields,
  recognized: TodoRecognitionDraft,
): TodoDraftFields {
  // 识别填入的字段以本次结果为准（没识别到的字段清空，不保留上一次识别的旧值，
  // 避免"换图重识别"时两张图的内容串在一起）；失败场景由调用方决定不应用。
  const customerName = cleanRecognizedText(recognized.customerName);
  const title = cleanRecognizedText(recognized.title);
  const note = cleanRecognizedText(recognized.note);
  const receivedAt = normalizeTodoRecognitionDueAt(recognized.receivedAt);
  const dueAt = normalizeTodoRecognitionDueAt(recognized.dueAt);
  const attachmentPaths = mergeTodoAttachmentPaths(
    current.attachmentPaths,
    recognized.attachmentPaths,
  );

  return {
    customerName: customerName ?? "",
    title: title ?? "",
    note: note ?? "",
    receivedAt: receivedAt ?? "",
    dueAt: recognized.dueAt === null ? "" : dueAt ?? "",
    reminderAt: current.reminderAt,
    category: current.category,
    attachmentPaths,
  };
}

export function reorderTodoAttachmentPaths(paths: string[], sourcePath: string, targetPath: string) {
  const sourceIndex = paths.indexOf(sourcePath);
  const targetIndex = paths.indexOf(targetPath);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return paths;

  const next = [...paths];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

function mergeTodoAttachmentPaths(current: string[], recognized: string[] | null | undefined) {
  const merged = [...current];
  const seen = new Set(current);

  for (const rawPath of recognized ?? []) {
    const path = cleanRecognizedText(rawPath);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    merged.push(path);
  }

  return merged;
}
