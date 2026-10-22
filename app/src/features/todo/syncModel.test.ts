import { describe, expect, it } from "vitest";
import {
  buildAssigneeOptions,
  buildMemberBoardOptions,
  filterTasksByMember,
  getMemberDisplayName,
  taskMatchesMember,
} from "./syncModel";
import type { TodoTask } from "../../contracts/todo";
import type { SyncMember } from "../../contracts/sync";

function makeTask(over: Partial<TodoTask> & { id: string }): TodoTask {
  return {
    customerName: "",
    title: over.id,
    note: "",
    status: "pending",
    receivedAt: "2026-10-22T09:00:00+08:00",
    dueAt: null,
    completedAt: null,
    attachmentPaths: [],
    ...over,
  };
}

const me: SyncMember = { memberId: "m_me", nickname: "我", joinedAt: "2026-10-22T00:00:00Z" };
const wang: SyncMember = { memberId: "m_wang", nickname: "老王", joinedAt: "2026-10-21T00:00:00Z" };

describe("成员归属判定", () => {
  it("owner 或 assignee 命中都算归属，都不命中不算", () => {
    expect(taskMatchesMember(makeTask({ id: "a", owner: "m_me" }), "m_me")).toBe(true);
    expect(taskMatchesMember(makeTask({ id: "b", assignee: "m_me" }), "m_me")).toBe(true);
    expect(taskMatchesMember(makeTask({ id: "c", owner: "m_wang", assignee: null }), "m_me")).toBe(false);
    expect(taskMatchesMember(makeTask({ id: "d" }), "m_me")).toBe(false);
  });
});

describe("成员分段计数（从任务集现算）", () => {
  const tasks = [
    makeTask({ id: "a", status: "pending", owner: "m_me" }),
    makeTask({ id: "b", status: "in_progress", assignee: "m_me" }),
    makeTask({ id: "c", status: "completed", owner: "m_wang" }),
    makeTask({ id: "d", status: "waiting", owner: "m_me" }),
  ];

  it("我 / 全部 / 各成员顺序正确，waiting 不计入三格", () => {
    const options = buildMemberBoardOptions(tasks, [me, wang], "m_me");
    expect(options.map(option => option.key)).toEqual(["me", "all", "m_wang"]);
    const mine = options.find(option => option.key === "me")!;
    expect(mine.count).toEqual({ pending: 1, in_progress: 1, completed: 0 });
    const all = options.find(option => option.key === "all")!;
    expect(all.count).toEqual({ pending: 1, in_progress: 1, completed: 1 });
    const laowang = options.find(option => option.key === "m_wang")!;
    expect(laowang.count).toEqual({ pending: 0, in_progress: 0, completed: 1 });
  });

  it("未拿到 memberId 时不出现「我」视角", () => {
    const options = buildMemberBoardOptions(tasks, [me, wang], null);
    expect(options.map(option => option.key)).toEqual(["all", "m_me", "m_wang"]);
  });
});

describe("成员视角筛选", () => {
  const tasks = [
    makeTask({ id: "a", owner: "m_me" }),
    makeTask({ id: "b", assignee: "m_wang" }),
    makeTask({ id: "c", owner: "m_wang", assignee: "m_me" }),
  ];

  it("全部视角原样返回", () => {
    expect(filterTasksByMember(tasks, "all", "m_me")).toHaveLength(3);
  });

  it("「我」按 owner 或 assignee 命中收敛", () => {
    const mine = filterTasksByMember(tasks, "me", "m_me");
    expect(mine.map(task => task.id)).toEqual(["a", "c"]);
  });

  it("未拿到 memberId 时「我」不收敛，避免清空列表", () => {
    expect(filterTasksByMember(tasks, "me", null)).toHaveLength(3);
  });

  it("指定成员只返回归属该成员的任务", () => {
    const laowang = filterTasksByMember(tasks, "m_wang", "m_me");
    expect(laowang.map(task => task.id)).toEqual(["b", "c"]);
  });
});

describe("指派选项与展示名", () => {
  it("昵称缺失回退 memberId", () => {
    expect(getMemberDisplayName(undefined, "m_x")).toBe("m_x");
    expect(getMemberDisplayName({ memberId: "m_x", nickname: "  ", joinedAt: "" }, "m_x")).toBe("m_x");
    expect(getMemberDisplayName(me, "m_me")).toBe("我");
  });

  it("保留已指派但不在成员列表里的 memberId，避免下拉空白", () => {
    const options = buildAssigneeOptions([me], "m_ghost");
    expect(options).toEqual([
      { value: "m_me", label: "我" },
      { value: "m_ghost", label: "m_ghost" },
    ]);
  });

  it("成员已在列表时不重复追加当前指派", () => {
    expect(buildAssigneeOptions([me], "m_me")).toEqual([{ value: "m_me", label: "我" }]);
  });
});
