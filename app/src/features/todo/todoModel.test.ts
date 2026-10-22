import { describe, expect, it } from "vitest";
import {
  DEFAULT_TODO_QUICK_DUE_OPTIONS,
  applyTodoRecognitionDraft,
  formatTodoReceivedLabel,
  getFilteredTodoTasks,
  getTodoDeferOptions,
  getTodoDueInfo,
  getTodoListSlice,
  getTodoStatusCounts,
  getTodoWorkflowActions,
  normalizeTodoRecognitionDueAt,
  normalizeTodoQuickDueOptions,
  parseTodoQuickDueOptions,
  reorderTodoAttachmentPaths,
  serializeTodoQuickDueOptions,
  getVisibleTodoTasks,
  matchTodoSearch,
  shouldShowTodoNote,
  toTodoDateInputValue,
  toTodoIsoDate,
  type TodoTask,
} from "./todoModel";

const noDueTask: TodoTask = {
  id: "sample-1",
  customerName: "示例客户",
  title: "准备示例文档",
  note: "",
  status: "pending",
  receivedAt: "2026-09-05T09:00:00+08:00",
  dueAt: null,
  urgentAt: null,
  completedAt: null,
  attachmentPaths: [],
};

describe("独立待办规则", () => {
  it("无交付日期的未完成任务仍在今日，且不显示逾期", () => {
    const now = new Date("2026-09-05T12:00:00+08:00");
    expect(getFilteredTodoTasks([noDueTask], "today", now)).toEqual([noDueTask]);
    expect(getTodoDueInfo(noDueTask, now)).toBeNull();
  });

  it("已完成任务没有记账入口，保留恢复", () => {
    const completed: TodoTask = { ...noDueTask, status: "completed" };
    expect(getTodoWorkflowActions(completed)).toEqual(["restore"]);
  });
});

describe("todoModel", () => {
  describe("quick due options", () => {
    it("falls back to defaults for invalid JSON", () => {
      expect(parseTodoQuickDueOptions("not json")).toEqual(DEFAULT_TODO_QUICK_DUE_OPTIONS);
    });

    it("keeps valid labels including today with zero day offset", () => {
      expect(normalizeTodoQuickDueOptions([{ label: "今天", days: 0 }])).toEqual([
        { label: "今天", days: 0 },
      ]);
    });

    it("drops invalid labels and day offsets", () => {
      expect(
        normalizeTodoQuickDueOptions([
          { label: "", days: 1 },
          { label: "太远", days: 366 },
          { label: "明天", days: 1 },
        ]),
      ).toEqual([{ label: "明天", days: 1 }]);
    });

    it("serializes normalized options", () => {
      expect(serializeTodoQuickDueOptions([{ label: "后天", days: 2 }])).toBe(
        '[{"label":"后天","days":2}]',
      );
    });
  });

  it("orders active work before completed work", () => {
    const tasks: TodoTask[] = [
      {
        id: "3",
        customerName: "王老师",
        title: "已交付海报",
        note: "",
        status: "completed",
        receivedAt: "2026-06-24T08:00:00.000Z",
        dueAt: null,
        completedAt: "2026-06-24T10:00:00.000Z",
        attachmentPaths: [],
      },
      {
        id: "1",
        customerName: "李老板",
        title: "确认门头尺寸",
        note: "",
        status: "pending",
        receivedAt: "2026-06-24T09:00:00.000Z",
        dueAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "2",
        customerName: "张园长",
        title: "拆背景板",
        note: "",
        status: "in_progress",
        receivedAt: "2026-06-24T07:00:00.000Z",
        dueAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
    ];

    expect(getVisibleTodoTasks(tasks).map((task) => task.id)).toEqual(["1", "2", "3"]);
  });

  it("orders urgent active cards before normal cards by latest urgent time", () => {
    const tasks: TodoTask[] = [
      {
        id: "normal-overdue",
        customerName: "客户",
        title: "普通逾期",
        note: "",
        status: "pending",
        receivedAt: "2026-06-20T09:00:00.000Z",
        dueAt: "2026-06-23T00:00:00.000Z",
        urgentAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "urgent-old",
        customerName: "客户",
        title: "较早加急",
        note: "",
        status: "pending",
        receivedAt: "2026-06-24T08:00:00.000Z",
        dueAt: "2026-06-30T00:00:00.000Z",
        urgentAt: "2026-06-25T08:00:00.000Z",
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "urgent-new",
        customerName: "客户",
        title: "最新加急",
        note: "",
        status: "in_progress",
        receivedAt: "2026-06-24T07:00:00.000Z",
        dueAt: "2026-07-01T00:00:00.000Z",
        urgentAt: "2026-06-25T09:00:00.000Z",
        completedAt: null,
        attachmentPaths: [],
      },
    ];

    expect(getVisibleTodoTasks(tasks).map((task) => task.id)).toEqual([
      "urgent-new",
      "urgent-old",
      "normal-overdue",
    ]);
  });

  it("orders active cards by due urgency after urgent cards", () => {
    const tasks: TodoTask[] = [
      {
        id: "unscheduled",
        customerName: "客户",
        title: "未设交付",
        note: "",
        status: "pending",
        receivedAt: "2026-06-25T09:00:00.000Z",
        dueAt: null,
        urgentAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "future-late",
        customerName: "客户",
        title: "较晚交付",
        note: "",
        status: "pending",
        receivedAt: "2026-06-25T08:00:00.000Z",
        dueAt: "2026-07-03T00:00:00.000Z",
        urgentAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "today-progress",
        customerName: "客户",
        title: "今日进行中",
        note: "",
        status: "in_progress",
        receivedAt: "2026-06-24T08:00:00.000Z",
        dueAt: "2026-06-25T00:00:00.000Z",
        urgentAt: null,
        completedAt: null,
        updatedAt: "2026-06-25T10:00:00.000Z",
        attachmentPaths: [],
      },
      {
        id: "overdue-less",
        customerName: "客户",
        title: "轻度逾期",
        note: "",
        status: "pending",
        receivedAt: "2026-06-23T08:00:00.000Z",
        dueAt: "2026-06-23T00:00:00.000Z",
        urgentAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "overdue-most",
        customerName: "客户",
        title: "最久逾期",
        note: "",
        status: "pending",
        receivedAt: "2026-06-20T08:00:00.000Z",
        dueAt: "2026-06-20T00:00:00.000Z",
        urgentAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "future-near",
        customerName: "客户",
        title: "较近交付",
        note: "",
        status: "pending",
        receivedAt: "2026-06-25T07:00:00.000Z",
        dueAt: "2026-06-27T00:00:00.000Z",
        urgentAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
    ];

    expect(getVisibleTodoTasks(tasks).map((task) => task.id)).toEqual([
      "overdue-most",
      "overdue-less",
      "today-progress",
      "future-near",
      "future-late",
      "unscheduled",
    ]);
  });

  it("orders completed cards by latest completed time", () => {
    const tasks: TodoTask[] = [
      {
        id: "old-completed",
        customerName: "客户",
        title: "较早完成",
        note: "",
        status: "completed",
        receivedAt: "2026-06-27T08:00:00.000Z",
        dueAt: "2026-06-21T00:00:00.000Z",
        urgentAt: "2026-06-21T08:00:00.000Z",
        completedAt: "2026-06-22T09:00:00.000Z",
        attachmentPaths: [],
      },
      {
        id: "fallback-updated",
        customerName: "客户",
        title: "无完成时间",
        note: "",
        status: "completed",
        receivedAt: "2026-06-24T08:00:00.000Z",
        dueAt: "2026-06-25T00:00:00.000Z",
        urgentAt: null,
        completedAt: null,
        updatedAt: "2026-06-26T09:00:00.000Z",
        attachmentPaths: [],
      },
      {
        id: "new-completed",
        customerName: "客户",
        title: "最近完成",
        note: "",
        status: "completed",
        receivedAt: "2026-06-23T08:00:00.000Z",
        dueAt: "2026-06-24T00:00:00.000Z",
        urgentAt: null,
        completedAt: "2026-06-25T09:00:00.000Z",
        attachmentPaths: [],
      },
    ];

    expect(getVisibleTodoTasks(tasks).map((task) => task.id)).toEqual([
      "fallback-updated",
      "new-completed",
      "old-completed",
    ]);
  });

  it("counts tasks by workflow status", () => {
    const tasks: TodoTask[] = [
      {
        id: "1",
        customerName: "A",
        title: "A",
        note: "",
        status: "pending",
        receivedAt: "2026-06-24T09:00:00.000Z",
        dueAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "2",
        customerName: "B",
        title: "B",
        note: "",
        status: "in_progress",
        receivedAt: "2026-06-24T08:00:00.000Z",
        dueAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "3",
        customerName: "C",
        title: "C",
        note: "",
        status: "completed",
        receivedAt: "2026-06-24T07:00:00.000Z",
        dueAt: null,
        completedAt: "2026-06-24T10:00:00.000Z",
        attachmentPaths: [],
      },
      {
        id: "4",
        customerName: "D",
        title: "D",
        note: "",
        status: "pending",
        receivedAt: "2026-06-24T06:00:00.000Z",
        dueAt: "2026-06-30T07:00:00.000Z",
        completedAt: null,
        attachmentPaths: [],
      },
    ];

    expect(getTodoStatusCounts(tasks, new Date("2026-06-25T10:00:00.000Z"))).toEqual({
      today: 2,
      pending: 2,
      in_progress: 1,
      waiting: 0,
      completed: 1,
    });
  });

  it("filters today's attention list without showing future or completed work", () => {
    const tasks: TodoTask[] = [
      {
        id: "overdue",
        customerName: "客户",
        title: "逾期",
        note: "",
        status: "pending",
        receivedAt: "2026-06-20T09:00:00.000Z",
        dueAt: "2026-06-23T00:00:00.000Z",
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "today",
        customerName: "客户",
        title: "今日",
        note: "",
        status: "in_progress",
        receivedAt: "2026-06-24T09:00:00.000Z",
        dueAt: "2026-06-25T08:00:00.000Z",
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "unscheduled",
        customerName: "客户",
        title: "无截止",
        note: "",
        status: "pending",
        receivedAt: "2026-06-24T08:00:00.000Z",
        dueAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "future",
        customerName: "客户",
        title: "未来",
        note: "",
        status: "pending",
        receivedAt: "2026-06-24T07:00:00.000Z",
        dueAt: "2026-06-26T00:00:00.000Z",
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "done",
        customerName: "客户",
        title: "完成",
        note: "",
        status: "completed",
        receivedAt: "2026-06-24T06:00:00.000Z",
        dueAt: "2026-06-25T00:00:00.000Z",
        completedAt: "2026-06-25T09:00:00.000Z",
        attachmentPaths: [],
      },
    ];

    expect(
      getFilteredTodoTasks(tasks, "today", new Date("2026-06-25T10:00:00.000Z")).map(
        (task) => task.id,
      ),
    ).toEqual(["overdue", "today", "unscheduled"]);
  });

  it("includes urgent future work in today's attention list", () => {
    const tasks: TodoTask[] = [
      {
        id: "urgent-future",
        customerName: "客户",
        title: "未来加急",
        note: "",
        status: "pending",
        receivedAt: "2026-06-24T09:00:00.000Z",
        dueAt: "2026-06-30T00:00:00.000Z",
        urgentAt: "2026-06-25T09:00:00.000Z",
        completedAt: null,
        attachmentPaths: [],
      },
      {
        id: "normal-future",
        customerName: "客户",
        title: "未来普通",
        note: "",
        status: "pending",
        receivedAt: "2026-06-24T08:00:00.000Z",
        dueAt: "2026-06-30T00:00:00.000Z",
        urgentAt: null,
        completedAt: null,
        attachmentPaths: [],
      },
    ];

    expect(
      getFilteredTodoTasks(tasks, "today", new Date("2026-06-25T10:00:00.000Z")).map(
        (task) => task.id,
      ),
    ).toEqual(["urgent-future"]);
  });

  it("matches card workflow actions for each status without a ledger entry", () => {
    const baseTask: TodoTask = {
      id: "task",
      customerName: "客户",
      title: "任务",
      note: "",
      status: "pending",
      receivedAt: "2026-06-24T09:00:00.000Z",
      dueAt: "2026-06-25T09:00:00.000Z",
      completedAt: null,
      attachmentPaths: [],
    };

    expect(getTodoWorkflowActions(baseTask)).toEqual(["start"]);
    expect(getTodoWorkflowActions({ ...baseTask, status: "in_progress" })).toEqual([
      "wait",
      "rollback",
      "complete",
    ]);
    expect(getTodoWorkflowActions({ ...baseTask, status: "waiting" })).toEqual([
      "resume",
      "complete",
    ]);
    expect(getTodoWorkflowActions({ ...baseTask, status: "completed" })).toEqual(["restore"]);
  });

  it("builds old-app defer choices from today", () => {
    expect(getTodoDeferOptions(new Date("2026-06-25T10:00:00.000Z"))).toEqual([
      { key: "tomorrow", label: "明天", dateLabel: "6月26日", date: "2026-06-26" },
      { key: "day_after_tomorrow", label: "后天", dateLabel: "6月27日", date: "2026-06-27" },
      { key: "next_monday", label: "下周一", dateLabel: "6月29日", date: "2026-06-29" },
    ]);
  });

  it("shows list items in batches of ten", () => {
    const tasks: TodoTask[] = Array.from({ length: 23 }, (_, index) => ({
      id: String(index + 1),
      customerName: "客户",
      title: `任务 ${index + 1}`,
      note: "",
      status: "pending",
      receivedAt: "2026-06-24T09:00:00.000Z",
      dueAt: null,
      completedAt: null,
      attachmentPaths: [],
    }));

    expect(getTodoListSlice(tasks, 10)).toEqual({
      items: tasks.slice(0, 10),
      hasMore: true,
      hiddenCount: 13,
    });
    expect(getTodoListSlice(tasks, 30)).toEqual({
      items: tasks,
      hasMore: false,
      hiddenCount: 0,
    });
  });

  it("keeps completed task notes readable as in the old client", () => {
    const completed: TodoTask = {
      id: "done",
      customerName: "客户",
      title: "已完成任务",
      note: "这段备注在历史列表里不需要默认展示",
      status: "completed",
      receivedAt: "2026-06-20T09:00:00.000Z",
      dueAt: "2026-06-21T09:00:00.000Z",
      completedAt: "2026-06-22T09:00:00.000Z",
      attachmentPaths: [],
    };

    expect(shouldShowTodoNote(completed)).toBe(true);
  });

  it("describes overdue tasks by whole days", () => {
    const task: TodoTask = {
      id: "late",
      customerName: "客户",
      title: "逾期任务",
      note: "",
      status: "pending",
      receivedAt: "2026-06-20T09:00:00.000Z",
      dueAt: "2026-06-23T00:00:00.000Z",
      completedAt: null,
      attachmentPaths: [],
    };

    expect(getTodoDueInfo(task, new Date("2026-06-25T10:00:00.000Z"))).toEqual({
      tone: "overdue",
      label: "逾期 2 天",
    });
  });

  it("uses the old-app wording for tasks due today", () => {
    const task: TodoTask = {
      id: "today",
      customerName: "客户",
      title: "今日任务",
      note: "",
      status: "pending",
      receivedAt: "2026-06-25T08:00:00.000Z",
      dueAt: "2026-06-25T08:00:00.000Z",
      completedAt: null,
      attachmentPaths: [],
    };

    expect(getTodoDueInfo(task, new Date("2026-06-25T10:00:00.000Z"))?.label).toBe("今日交付");
  });

  it("formats received dates as compact month/day labels", () => {
    expect(formatTodoReceivedLabel("2026-06-17T00:00:00.000Z")).toBe("收 6月17日");
  });

  it("normalizes AI-recognized due dates for datetime-local inputs", () => {
    expect(normalizeTodoRecognitionDueAt("2026-06-26")).toBe("2026-06-26T00:00");
    expect(normalizeTodoRecognitionDueAt("2026-06-26T15:30:00.000Z")).toBe("2026-06-26T15:30:00.000Z");
    expect(normalizeTodoRecognitionDueAt("2026-09-06T00:30:00+08:00")).toBe("2026-09-05T16:30:00.000Z");
    expect(normalizeTodoRecognitionDueAt("")).toBe("");
    expect(normalizeTodoRecognitionDueAt("not a date")).toBe("");
  });

  it("识别结果为准：未识别字段清空（换图重识别不串词），附件合并保留", () => {
    expect(
      applyTodoRecognitionDraft(
        {
          customerName: "旧客户",
          title: "旧标题",
          note: "旧备注",
          receivedAt: "2026-06-25",
          dueAt: "",
          reminderAt: "", category: "",
          attachmentPaths: ["I:\existing.png"],
        },
        {
          customerName: "Recognized customer",
          title: "",
          note: null,
          receivedAt: null,
          dueAt: "2026-06-26",
          attachmentPaths: ["I:\shot.png", "I:\existing.png"],
        },
      ),
    ).toEqual({
      customerName: "Recognized customer",
      title: "",
      note: "",
      receivedAt: "",
      dueAt: "2026-06-26T00:00",
      reminderAt: "", category: "",
      attachmentPaths: ["I:\existing.png", "I:\shot.png"],
    });
  });

  it("识别结果为准：AI 未报告日期时清空默认/旧日期；无效日期保留原值", () => {
    const current = { customerName: "虚构客户", title: "初稿", note: "", receivedAt: "2026-09-06", dueAt: "2026-09-06", reminderAt: "", category: "", attachmentPaths: [] };
    expect(applyTodoRecognitionDraft(current, { dueAt: null }).dueAt).toBe("");
    expect(applyTodoRecognitionDraft(current, { note: "仅本地读取" }).dueAt).toBe("");
    expect(applyTodoRecognitionDraft(current, { dueAt: "无效日期" }).dueAt).toBe("");
  });

  it("识别隔离铁律：新图结果绝不含上一次图的内容（小陈≠小张）", () => {
    const first = applyTodoRecognitionDraft({ customerName: "", title: "", note: "", receivedAt: "", dueAt: "", reminderAt: "", category: "", attachmentPaths: [] }, {
      customerName: "小张", title: "交报表", note: "周五前", receivedAt: null, dueAt: "2026-09-11",
    });
    const second = applyTodoRecognitionDraft(first, {
      customerName: "小陈", title: "", note: "对折页", receivedAt: null, dueAt: null,
    });
    expect(second.customerName).toBe("小陈");
    expect(second.title).toBe("");
    expect(second.note).toBe("对折页");
    expect(second.dueAt).toBe("");
    expect(second).not.toMatchObject({ title: "交报表", note: "周五前" });
  });

  it("识别未提供日期时以识别为准清空；本地表单显示值保持原样", () => {
    const current = { customerName: "虚构客户", title: "初稿", note: "", receivedAt: "2026-09-06", dueAt: "2026-09-08", reminderAt: "", category: "", attachmentPaths: [] };
    expect(applyTodoRecognitionDraft(current, { note: "仅本地读取" }).receivedAt).toBe("");
    expect(applyTodoRecognitionDraft(current, { receivedAt: null, dueAt: null }).dueAt).toBe("");
    expect(toTodoDateInputValue("2024-02-29")).toBe("2024-02-29");
    expect(toTodoDateInputValue("2026-02-29")).toBe("");
    expect(toTodoDateInputValue("2026-13-01")).toBe("");
  });

  it("reorders todo attachment paths by drag source and drop target", () => {
    expect(reorderTodoAttachmentPaths(["a.png", "b.png", "c.png"], "c.png", "a.png")).toEqual([
      "c.png",
      "a.png",
      "b.png",
    ]);
    expect(reorderTodoAttachmentPaths(["a.png", "b.png", "c.png"], "a.png", "c.png")).toEqual([
      "b.png",
      "c.png",
      "a.png",
    ]);
    expect(reorderTodoAttachmentPaths(["a.png", "b.png"], "missing.png", "a.png")).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  it("searches customer, title and note case-insensitively", () => {
    const task: TodoTask = {
      ...noDueTask,
      customerName: "Li Boss",
      title: "确认门头尺寸",
      note: "周四下午送 IT 会馆",
    };

    expect(matchTodoSearch(task, "li")).toBe(true);
    expect(matchTodoSearch(task, "门头")).toBe(true);
    expect(matchTodoSearch(task, "会馆")).toBe(true);
    expect(matchTodoSearch(task, "不存在")).toBe(false);
    expect(matchTodoSearch(task, "   ")).toBe(true);
  });

  it("converts between form date values and ISO timestamps", () => {
    expect(toTodoIsoDate("")).toBeNull();
    expect(toTodoIsoDate("not-a-date")).toBeNull();
    expect(toTodoDateInputValue(null)).toBe("");
    expect(toTodoDateInputValue("2026-06-26T20:00:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const iso = toTodoIsoDate("2026-06-26");
    expect(iso).not.toBeNull();
    expect(toTodoDateInputValue(iso)).toBe("2026-06-26");
  });
});
