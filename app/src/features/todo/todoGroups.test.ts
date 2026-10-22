import { describe, expect, it } from "vitest";
import { getCompletedTodoGroups, getTodoDisplayGroups, getTodoDueInfo, getTodoListSlice, type TodoTask } from "./todoModel";

const now = new Date(2026, 8, 6, 12);
const date = (offset: number) => new Date(2026, 8, 6 + offset, 12).toISOString();
const task = (id: string, due: number | null, status: TodoTask["status"] = "pending"): TodoTask => ({
  id, customerName: "虚构客户", title: id, note: "", receivedAt: date(-2), dueAt: due === null ? null : date(due), status, completedAt: null, attachmentPaths: [],
});

describe("老版今日分组及交付标识", () => {
  it("完成七天边界按本地日历划分，缺失完成时间也不会丢记录", () => {
    const groups = getCompletedTodoGroups([
      {...task("today",0,"completed"),completedAt:date(0)},
      {...task("six-days",-6,"completed"),completedAt:date(-6)},
      {...task("seven-days",-7,"completed"),completedAt:date(-7)},
      {...task("fallback",-8,"completed"),updatedAt:date(-8)},
    ],now);
    expect(groups.recent.flatMap(g=>g.tasks.map(t=>t.id))).toEqual(["today","six-days"]);
    expect(groups.archived.flatMap(g=>g.tasks.map(t=>t.id))).toEqual(["seven-days","fallback"]);
    expect(groups.recent[0].label).toBe("今天");
  });
  it("手动归档（archivedAt）即便在近七天也进入归档桶，不留在最近", () => {
    const groups = getCompletedTodoGroups([
      {...task("recent-open",0,"completed"),completedAt:date(0)},
      {...task("recent-archived",0,"completed"),completedAt:date(0),archivedAt:date(0)},
    ],now);
    expect(groups.recent.flatMap(g=>g.tasks.map(t=>t.id))).toEqual(["recent-open"]);
    expect(groups.archived.flatMap(g=>g.tasks.map(t=>t.id))).toEqual(["recent-archived"]);
  });
  it("分组后无日期及未来加急任务不丢失，每个任务仅出现一次", () => {
    const tasks = [task("today-pending",0),task("unscheduled",null),{...task("urgent-future",4),urgentAt:date(0)},task("overdue",-2),task("today-progress",0,"in_progress")];
    const groups = getTodoDisplayGroups(tasks,"today",false,now);
    expect(groups.map(g=>g.label)).toEqual(["已逾期","今日到期 · 进行中","今日到期 · 未完成","加急","未设交付日期"]);
    const ids = groups.flatMap(g=>g.tasks.map(t=>t.id));
    expect(new Set(ids).size).toBe(tasks.length);
    expect(ids).toEqual(["overdue","today-progress","today-pending","urgent-future","unscheduled"]);
  });
  it("搜索保持跨状态分组，分页不改变总数或产生重复", () => {
    const tasks = Array.from({length:12},(_,i)=>task(`pending-${i}`,-i));
    tasks.push(task("done",-2,"completed"));
    const groups = getTodoDisplayGroups(tasks,"today",true,now);
    expect(groups.map(g=>[g.label,g.tasks.length])).toEqual([["未完成",12],["最近已完成",1]]);
    const slice = getTodoListSlice(groups.flatMap(g=>g.tasks),10);
    expect(slice.items).toHaveLength(10);
    expect(slice.hiddenCount).toBe(3);
  });
  it("未来日期及完成时点决定标识，不把已完成任务继续算作未交付逾期", () => {
    expect(getTodoDueInfo(task("tomorrow",1),now)?.label).toBe("明天交付");
    expect(getTodoDueInfo(task("future",4),now)).toEqual({tone:"normal",label:"9月10日"});
    expect(getTodoDueInfo({...task("done",-2,"completed"),completedAt:date(-2)},now)?.label).toBe("按时交付");
    expect(getTodoDueInfo({...task("late",-2,"completed"),completedAt:date(0)},now)?.label).toBe("逾期 2 天交付");
  });
});
