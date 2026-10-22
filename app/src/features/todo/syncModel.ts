/**
 * 团队看板成员视角纯逻辑：计数、筛选、指派选项。
 * 全部从当前已拉取的任务集现算，不读网络、不臆造数字；React 与服务都不参与本模块。
 */
import type { TodoTask } from "../../contracts/todo";
import type { SyncMember } from "../../contracts/sync";

/** 成员视角："all" 全部，"me" 我自己，其余为成员 ID。 */
export type MemberView = "all" | "me" | string;

/** 分段上展示的三态计数：待办 / 进行中 / 已完成（waiting 不计入这三格）。 */
export interface MemberStatusCount {
  pending: number;
  in_progress: number;
  completed: number;
}

export const EMPTY_MEMBER_COUNT: MemberStatusCount = { pending: 0, in_progress: 0, completed: 0 };

/** 任务归属某成员：创建者(owner)或被指派人(assignee)命中即算。 */
export function taskMatchesMember(task: TodoTask, memberId: string): boolean {
  return task.owner === memberId || task.assignee === memberId;
}

function countStatus(tasks: TodoTask[]): MemberStatusCount {
  const count: MemberStatusCount = { pending: 0, in_progress: 0, completed: 0 };
  for (const task of tasks) {
    if (task.status === "pending") count.pending += 1;
    else if (task.status === "in_progress") count.in_progress += 1;
    else if (task.status === "completed") count.completed += 1;
  }
  return count;
}

export interface MemberBoardOption {
  key: MemberView;
  label: string;
  count: MemberStatusCount;
}

/** 成员展示名：昵称优先，缺失时回退 memberId，绝不返回空串。 */
export function getMemberDisplayName(member: SyncMember | undefined, memberId: string): string {
  const nickname = member?.nickname?.trim();
  return nickname || memberId;
}

export function findMember(members: SyncMember[], memberId: string | null | undefined): SyncMember | undefined {
  if (!memberId) return undefined;
  return members.find(member => member.memberId === memberId);
}

/**
 * 分段选项顺序：我（拿到 memberId 才有）→ 全部 → 各成员。
 * 计数从传入的全量任务集现算；当前自己的成员不再单独重复列。
 */
export function buildMemberBoardOptions(
  tasks: TodoTask[],
  members: SyncMember[],
  currentMemberId: string | null,
): MemberBoardOption[] {
  const options: MemberBoardOption[] = [];
  if (currentMemberId) {
    options.push({
      key: "me",
      label: "我",
      count: countStatus(tasks.filter(task => taskMatchesMember(task, currentMemberId))),
    });
  }
  options.push({ key: "all", label: "全部", count: countStatus(tasks) });
  for (const member of members) {
    if (member.memberId === currentMemberId) continue;
    options.push({
      key: member.memberId,
      label: getMemberDisplayName(member, member.memberId),
      count: countStatus(tasks.filter(task => taskMatchesMember(task, member.memberId))),
    });
  }
  return options;
}

/**
 * 按视角收敛任务："all" 原样返回；"me" 在未拿到 memberId 时不收敛（保持全量），
 * 避免无身份时把列表清空。
 */
export function filterTasksByMember(
  tasks: TodoTask[],
  view: MemberView,
  currentMemberId: string | null,
): TodoTask[] {
  if (view === "all") return tasks;
  const memberId = view === "me" ? currentMemberId : view;
  if (!memberId) return tasks;
  return tasks.filter(task => taskMatchesMember(task, memberId));
}

export interface AssigneeOption {
  value: string;
  label: string;
}

/**
 * 指派下拉选项：服务端成员 + 「清除指派」占位由 UI 处理；
 * 当前已指派但不在成员列表里的 ID 也要保留为选项，避免 select 出现空白回退。
 */
export function buildAssigneeOptions(
  members: SyncMember[],
  currentAssignee: string | null | undefined,
): AssigneeOption[] {
  const options = members.map(member => ({
    value: member.memberId,
    label: getMemberDisplayName(member, member.memberId),
  }));
  if (currentAssignee && !options.some(option => option.value === currentAssignee)) {
    options.push({ value: currentAssignee, label: currentAssignee });
  }
  return options;
}
