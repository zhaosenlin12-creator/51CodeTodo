import { describe, expect, it } from "vitest";
import type { TodoDraft, TodoServices, TodoTask } from "../../contracts/todo";
import { createTodoControllerCore } from "./useTodoController";

function makeTask(overrides: Partial<TodoTask> = {}): TodoTask {
  return {
    id: "task-1",
    customerName: "示例客户",
    title: "准备示例文档",
    note: "",
    status: "pending",
    receivedAt: "2026-09-05T09:00:00.000Z",
    dueAt: null,
    urgentAt: null,
    completedAt: null,
    attachmentPaths: [],
    ...overrides,
  };
}

function makeServices(overrides: Partial<TodoServices> = {}): TodoServices {
  return {
    listTasks: () => Promise.resolve([]),
    createTask: () => Promise.resolve(makeTask()),
    updateTask: () => Promise.resolve(makeTask()),
    setTaskStatus: () => Promise.resolve(makeTask()),
    setTaskUrgent: () => Promise.resolve(makeTask()),
    deleteTask: () => Promise.resolve(),
    recognizeClipboard: () =>
      Promise.resolve({ kind: "empty", message: "剪贴板没有可用内容" }),
    recognizeAttachment: () =>
      Promise.resolve({ kind: "empty", message: "附件识别未完成" }),
    saveClipboardAttachment: () => Promise.resolve(null),
    getAttachmentDataUrl: () => Promise.resolve("data:image/png;base64,stub"),
    ...overrides,
  };
}

const sampleDraft: TodoDraft = {
  customerName: "新客户",
  title: "新任务",
  note: "",
  receivedAt: "2026-09-05T00:00:00.000Z",
  dueAt: null,
  attachmentPaths: [],
};

describe("todo controller core", () => {
  it("searches all statuses and restores the original filter when cleared", async () => {
    const tasks = [
      makeTask({ id: "pending", title: "星河展板", dueAt: "2099-01-01T00:00:00Z" }),
      makeTask({ id: "working", status: "in_progress", title: "确认展板" }),
      makeTask({ id: "done", status: "completed", note: "展板发票" }),
      makeTask({ id: "other", title: "其他事项" }),
    ];
    const core = createTodoControllerCore(makeServices({ listTasks: async () => tasks }));
    await core.loadTasks();
    core.setSearch("展板");
    expect(core.getState().visibleTasks.map(t => t.id).sort()).toEqual(["done", "pending", "working"]);
    expect(core.getState().counts.pending).toBe(2);
    core.setSearch("未出现的关键字");
    expect(core.getState().visibleTasks).toEqual([]);
    core.setSearch("");
    expect(core.getState().status).toBe("today");
    expect(core.getState().visibleTasks.map(t => t.id).sort()).toEqual(["other", "working"]);
  });
  it.each(["create", "update", "status", "urgent", "delete"] as const)(
    "preserves a successful %s when an earlier list response arrives late",
    async (operation) => {
      let release!: (tasks: TodoTask[]) => void;
      const oldTask = makeTask();
      const saved = makeTask({ title: "已经保存的新内容", status: "in_progress" });
      const core = createTodoControllerCore(makeServices({
        listTasks: () => new Promise((resolve) => { release = resolve; }),
        createTask: () => Promise.resolve(saved),
        updateTask: () => Promise.resolve(saved),
        setTaskStatus: () => Promise.resolve(saved),
        setTaskUrgent: () => Promise.resolve(saved),
      }));
      const loading = core.loadTasks();
      if (operation === "create") await core.createTask(sampleDraft);
      if (operation === "update") await core.updateTask(oldTask.id, sampleDraft);
      if (operation === "status") await core.setTaskStatus(oldTask.id, "in_progress");
      if (operation === "urgent") await core.setTaskUrgent(oldTask.id, true);
      if (operation === "delete") await core.deleteTask(oldTask.id);
      const untouched = makeTask({ id: "existing-2" });
      release([...(operation === "create" ? [] : [oldTask]), untouched]);
      await loading;
      expect(core.getState().tasks.find((task) => task.id === oldTask.id))
        .toEqual(operation === "delete" ? undefined : saved);
      expect(core.getState().tasks).toContainEqual(untouched);
      expect(core.getState().loading).toBe(false);
    },
  );

  it("rejects status and deletion while the same task is being edited", async () => {
    let release!: (task: TodoTask) => void;
    const core = createTodoControllerCore(makeServices({
      updateTask: () => new Promise((resolve) => { release = resolve; }),
    }));
    const writing = core.updateTask("task-1", sampleDraft);
    expect(await core.setTaskStatus("task-1", "completed")).toMatchObject({ ok: false });
    expect(await core.deleteTask("task-1")).toMatchObject({ ok: false });
    release(makeTask());
    expect(await writing).toEqual({ ok: true });
    expect(core.getState().busyTaskIds).toEqual([]);
  });

  it("loads tasks once and derives today filter with counts", async () => {
    const tasks = [
      makeTask({ id: "1", status: "pending", dueAt: null }),
      makeTask({ id: "2", status: "in_progress" }),
      makeTask({ id: "3", status: "completed", completedAt: "2026-09-05T10:00:00.000Z" }),
    ];
    const core = createTodoControllerCore(makeServices({ listTasks: () => Promise.resolve(tasks) }));

    await core.loadTasks();

    const state = core.getState();
    expect(state.loading).toBe(false);
    expect(state.loadError).toBeNull();
    expect(state.tasks).toHaveLength(3);
    expect(state.counts.completed).toBe(1);
    expect(state.visibleTasks.map((task) => task.id)).toEqual(["1", "2"]);
  });

  it("surfaces list loading failures instead of swallowing them", async () => {
    const core = createTodoControllerCore(
      makeServices({ listTasks: () => Promise.reject(new Error("数据库打不开")) }),
    );

    await core.loadTasks();

    const state = core.getState();
    expect(state.loading).toBe(false);
    expect(state.loadError).toBe("数据库打不开");
  });

  it("creates a task with the saved result and reports success", async () => {
    const saved = makeTask({ id: "new-1", title: "新任务" });
    const core = createTodoControllerCore(
      makeServices({ createTask: () => Promise.resolve(saved) }),
    );
    await core.loadTasks();

    const result = await core.createTask(sampleDraft);

    expect(result).toEqual({ ok: true });
    expect(core.getState().tasks.map((task) => task.id)).toContain("new-1");
    expect(core.getState().saving).toBe(false);
  });

  it("keeps the list unchanged and reports the message when saving fails", async () => {
    const core = createTodoControllerCore(
      makeServices({
        listTasks: () => Promise.resolve([makeTask({ id: "1" })]),
        createTask: () => Promise.reject(new Error("磁盘已满")),
      }),
    );
    await core.loadTasks();

    const result = await core.createTask(sampleDraft);

    expect(result).toEqual({ ok: false, message: "磁盘已满" });
    expect(core.getState().tasks.map((task) => task.id)).toEqual(["1"]);
    expect(core.getState().saving).toBe(false);
  });

  it("rejects duplicate submits while a save is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = createTodoControllerCore(
      makeServices({ createTask: () => gate.then(() => makeTask({ id: "new-1" })) }),
    );
    await core.loadTasks();

    const first = core.createTask(sampleDraft);
    const second = await core.createTask(sampleDraft);
    expect(second).toEqual({ ok: false, message: expect.stringContaining("请稍候") });
    release();
    await first;

    expect(core.getState().tasks).toHaveLength(1);
  });

  it.each(["create", "update"] as const)("does not start recognition while %s is saving the draft", async (operation) => {
    let release!: (task: TodoTask) => void;
    let recognitionCalls = 0;
    const pending = () => new Promise<TodoTask>((resolve) => { release = resolve; });
    const core = createTodoControllerCore(makeServices({
      createTask: pending,
      updateTask: pending,
      recognizeClipboard: async () => { recognitionCalls += 1; return { kind: "ai", draft: { title: "不应覆盖正在保存的草稿" } }; },
    }));
    const saving = operation === "create" ? core.createTask(sampleDraft) : core.updateTask("task-1", sampleDraft);
    try {
      expect(await core.recognizeClipboard()).toBeNull();
      expect(recognitionCalls).toBe(0);
      expect(core.getState().recognizing).toBe(false);
    } finally {
      release(makeTask());
      await saving;
    }
  });

  it.each(["create", "update"] as const)("rejects %s while recognition is still filling the draft", async (operation) => {
    let release!: () => void;
    let writes = 0;
    const save = async () => { writes += 1; return makeTask(); };
    const core = createTodoControllerCore(makeServices({
      createTask: save,
      updateTask: save,
      recognizeClipboard: () => new Promise((resolve) => { release = () => resolve({ kind: "ai", draft: { title: "识别完成后待核对" } }); }),
    }));
    const recognizing = core.recognizeClipboard();
    try {
      const result = operation === "create" ? await core.createTask(sampleDraft) : await core.updateTask("task-1", sampleDraft);
      expect(result).toMatchObject({ ok: false });
      expect(writes).toBe(0);
      expect(core.getState().saving).toBe(false);
    } finally {
      release();
      await recognizing;
    }
    const retry = operation === "create" ? await core.createTask(sampleDraft) : await core.updateTask("task-1", sampleDraft);
    expect(retry).toEqual({ ok: true });
    expect(writes).toBe(1);
  });

  it("replaces the task with the returned status after setTaskStatus", async () => {
    const updated = makeTask({ id: "1", status: "in_progress" });
    const core = createTodoControllerCore(
      makeServices({
        listTasks: () => Promise.resolve([makeTask({ id: "1" })]),
        setTaskStatus: () => Promise.resolve(updated),
      }),
    );
    await core.loadTasks();

    const result = await core.setTaskStatus("1", "in_progress");

    expect(result).toEqual({ ok: true });
    expect(core.getState().tasks[0].status).toBe("in_progress");
    expect(core.getState().busyTaskIds).toEqual([]);
  });

  it("keeps the task and reports the message when deletion fails", async () => {
    const core = createTodoControllerCore(
      makeServices({
        listTasks: () => Promise.resolve([makeTask({ id: "1" })]),
        deleteTask: () => Promise.reject(new Error("删除被拒绝")),
      }),
    );
    await core.loadTasks();

    const result = await core.deleteTask("1");

    expect(result).toEqual({ ok: false, message: "删除被拒绝" });
    expect(core.getState().tasks.map((task) => task.id)).toEqual(["1"]);
    expect(core.getState().deletingTaskId).toBeNull();
  });

  it("removes the task only after deletion succeeds", async () => {
    const core = createTodoControllerCore(
      makeServices({
        listTasks: () => Promise.resolve([makeTask({ id: "1" }), makeTask({ id: "2" })]),
      }),
    );
    await core.loadTasks();

    const result = await core.deleteTask("1");

    expect(result).toEqual({ ok: true });
    expect(core.getState().tasks.map((task) => task.id)).toEqual(["2"]);
  });

  it("returns the AI outcome for successful recognition", async () => {
    const draft = { customerName: "识别客户", title: "识别任务" };
    const core = createTodoControllerCore(
      makeServices({ recognizeClipboard: () => Promise.resolve({ kind: "ai", draft }) }),
    );

    const outcome = await core.recognizeClipboard();

    expect(outcome).toEqual({ kind: "ai", draft });
    expect(core.getState().recognizing).toBe(false);
  });

  it("reports empty clipboard content without turning it into an AI success", async () => {
    const core = createTodoControllerCore(
      makeServices({
        recognizeClipboard: () => Promise.resolve({ kind: "empty", message: "没有可用内容" }),
      }),
    );

    const outcome = await core.recognizeClipboard();

    expect(outcome).toEqual({ kind: "empty", message: "没有可用内容" });
  });

  it("preserves date warnings returned with an AI draft", async () => {
    const result = { kind: "ai" as const, draft: { title: "虚构任务", dueAt: null }, message: "交付日期未确定，请核对" };
    const core = createTodoControllerCore(makeServices({ recognizeClipboard: async () => result }));
    expect(await core.recognizeClipboard()).toEqual(result);
  });

  it("turns recognition exceptions into a readable error outcome", async () => {
    const core = createTodoControllerCore(
      makeServices({ recognizeClipboard: () => Promise.reject(new Error("AI 服务超时")) }),
    );

    const outcome = await core.recognizeClipboard();

    expect(outcome).toEqual({ kind: "error", message: "AI 服务超时" });
  });

  it("ignores recognition triggered while one is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = createTodoControllerCore(
      makeServices({
        recognizeClipboard: () => gate.then(() => ({ kind: "ai" as const, draft: {} })),
      }),
    );

    const first = core.recognizeClipboard();
    expect(await core.recognizeClipboard()).toBeNull();
    release();
    await first;
  });

  it("returns a null attachment path as ok without an attachment", async () => {
    const core = createTodoControllerCore(makeServices());

    const result = await core.saveClipboardAttachment();

    expect(result).toEqual({ ok: true, path: null });
  });

  it("filters visible tasks by search across customer, title and note", async () => {
    const tasks = [
      makeTask({ id: "customer-hit", customerName: "李老板" }),
      makeTask({ id: "title-hit", title: "门头尺寸确认" }),
      makeTask({ id: "note-hit", note: "周四送到会馆" }),
      makeTask({ id: "miss", customerName: "王老师", title: "其他", note: "" }),
    ];
    const core = createTodoControllerCore(makeServices({ listTasks: () => Promise.resolve(tasks) }));
    await core.loadTasks();

    core.setSearch("会馆");
    expect(core.getState().visibleTasks.map((task) => task.id)).toEqual(["note-hit"]);

    core.setSearch("老板");
    expect(core.getState().visibleTasks.map((task) => task.id)).toEqual(["customer-hit"]);

    core.setSearch("");
    core.setStatus("completed");
    expect(core.getState().visibleTasks).toEqual([]);

    core.setStatus("pending");
    core.setSearch("");
    expect(core.getState().visibleTasks).toHaveLength(4);
  });

  it("locates an existing task by refreshing the list once", async () => {
    let calls = 0;
    const core = createTodoControllerCore(
      makeServices({
        listTasks: () => {
          calls += 1;
          return Promise.resolve(calls === 1 ? [] : [makeTask({ id: "late-arrival" })]);
        },
      }),
    );
    await core.loadTasks();

    const found = await core.ensureTask("late-arrival");

    expect(found?.id).toBe("late-arrival");
    expect(calls).toBe(2);
  });

  it("archives, unarchives and sets reminder through optional services", async () => {
    const archived = makeTask({
      status: "completed",
      completedAt: "2026-09-05T10:00:00.000Z",
      archivedAt: "2026-09-06T10:00:00.000Z",
    });
    const reminder = makeTask({ reminderAt: "2026-09-09T10:00:00+08:00", reminderRevision: 1 });
    const core = createTodoControllerCore(
      makeServices({
        listTasks: () => Promise.resolve([makeTask({ id: "task-1" })]),
        archiveTask: () => Promise.resolve(archived),
        unarchiveTask: () => Promise.resolve(makeTask({ id: "task-1", archivedAt: null })),
        setTaskReminder: () => Promise.resolve(reminder),
      }),
    );
    await core.loadTasks();

    expect(await core.archiveTask("task-1")).toEqual({ ok: true });
    expect(core.getState().tasks.find((t) => t.id === "task-1")?.archivedAt).toBe(
      "2026-09-06T10:00:00.000Z",
    );
    expect(await core.unarchiveTask("task-1")).toEqual({ ok: true });
    expect(await core.setTaskReminder("task-1", "2026-09-09T10:00:00+08:00")).toEqual({ ok: true });
    expect(core.getState().tasks.find((t) => t.id === "task-1")?.reminderAt).toBe(
      "2026-09-09T10:00:00+08:00",
    );
  });

  it("reports failure when optional archive service is absent", async () => {
    const core = createTodoControllerCore(makeServices());
    await core.loadTasks();
    expect(await core.archiveTask("task-1")).toMatchObject({ ok: false });
    expect(await core.setTaskReminder("task-1", null)).toMatchObject({ ok: false });
  });

  it("snoozes and cancels a reminder instance through optional services", async () => {
    const calls: Array<[string, number?]> = [];
    const core = createTodoControllerCore(makeServices({
      snoozeReminder: async (instanceId, minutes) => { calls.push([instanceId, minutes]); },
      cancelReminder: async (instanceId) => { calls.push([instanceId]); },
    }));
    await core.loadTasks();
    expect(await core.snoozeReminder("task-1:1", 10)).toEqual({ ok: true });
    expect(await core.cancelReminder("task-1:1")).toEqual({ ok: true });
    expect(calls).toEqual([["task-1:1", 10], ["task-1:1"]]);
  });

  it("reports failure when optional snooze/cancel service is absent", async () => {
    const core = createTodoControllerCore(makeServices());
    await core.loadTasks();
    expect(await core.snoozeReminder("task-1:1", 10)).toMatchObject({ ok: false });
    expect(await core.cancelReminder("task-1:1")).toMatchObject({ ok: false });
  });
});
