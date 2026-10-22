import { describe, expect, it } from "vitest";
import { createSyncServices } from "./syncServices";
import type { InvokeCommand } from "./todoServices";
import type { SyncConfigSnapshot, SyncSummary } from "../contracts/sync";

const snapshot: SyncConfigSnapshot = {
  enabled: true,
  serverUrl: "https://team.example.com",
  nickname: "小明",
  memberId: "m_1",
  hasToken: true,
  lastRev: 7,
  members: [{ memberId: "m_1", nickname: "小明", joinedAt: "2026-10-22T00:00:00Z" }],
};

describe("团队同步服务适配", () => {
  it("配置读写、加入、同步、成员与指派都走 PomeTodo 自己的命令并透传参数", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const summary: SyncSummary = { pushed: 2, pulled: 3, rev: 9, members: snapshot.members };
    const invoke: InvokeCommand = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "pometodo_sync_config_get") return snapshot as T;
      if (command === "pometodo_sync_config_update") return snapshot as T;
      if (command === "pometodo_sync_join") return snapshot.members[0] as T;
      if (command === "pometodo_sync_now") return summary as T;
      if (command === "pometodo_sync_members") return snapshot.members as T;
      return undefined as T;
    };
    const service = createSyncServices(invoke);
    await service.configGet();
    await service.configUpdate({ enabled: false, nickname: "小红" });
    await service.join();
    await service.syncNow();
    await service.members();
    await service.setAssignee("task-1", "m_2");
    await service.setAssignee("task-1", null);
    expect(calls).toEqual([
      { command: "pometodo_sync_config_get" },
      { command: "pometodo_sync_config_update", args: { patch: { enabled: false, nickname: "小红" } } },
      { command: "pometodo_sync_join" },
      { command: "pometodo_sync_now" },
      { command: "pometodo_sync_members" },
      { command: "pometodo_set_assignee", args: { id: "task-1", assignee: "m_2" } },
      { command: "pometodo_set_assignee", args: { id: "task-1", assignee: null } },
    ]);
  });

  it("把 Tauri 的字符串失败归一化为 Error 且不重试", async () => {
    let attempts = 0;
    const invoke: InvokeCommand = async () => { attempts += 1; throw "尚未加入团队，请先填写昵称并点击加入"; };
    await expect(createSyncServices(invoke).syncNow()).rejects.toThrow("尚未加入团队，请先填写昵称并点击加入");
    expect(attempts).toBe(1);
  });
});
