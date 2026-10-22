import { describe, expect, it } from "vitest";
import { createTodoServices, type InvokeCommand } from "./todoServices";
import type { TodoDraft, TodoTask } from "../contracts/todo";

const draft: TodoDraft = { customerName: "示例客户", title: "示例任务", note: "", receivedAt: "2026-09-06T09:00:00+08:00", dueAt: null, attachmentPaths: [] };
const task: TodoTask = { ...draft, id: "test-id", status: "pending", completedAt: null };

describe("真实宿主服务适配", () => {
  it("将空日期原样交给存储，返回原生保存结果而不重复加载", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const invoke: InvokeCommand = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return task as T;
    };
    const saved = await createTodoServices(invoke).createTask(draft);
    expect(saved).toEqual(task);
    expect(calls).toEqual([{ command: "pometodo_create_task", args: { draft } }]);
  });

  it("把 Tauri 的字符串失败变成 Error，保留可读原因并且不重试", async () => {
    let attempts = 0;
    const invoke: InvokeCommand = async () => { attempts += 1; throw "磁盘空间不足"; };
    await expect(createTodoServices(invoke).createTask(draft)).rejects.toThrow("磁盘空间不足");
    expect(attempts).toBe(1);
  });

  it("保留 local 与 empty 识别结果，不冒充 AI 成功", async () => {
    const local = { kind: "local", draft: { note: "虚构原文" }, message: "已读取文字" };
    const localInvoke: InvokeCommand = async <T>() => local as T;
    expect(await createTodoServices(localInvoke).recognizeClipboard()).toEqual(local);
    const empty = { kind: "empty", message: "剪贴板没有内容" };
    const emptyInvoke: InvokeCommand = async <T>() => empty as T;
    expect(await createTodoServices(emptyInvoke).recognizeClipboard()).toEqual(empty);
  });

  it("所有状态和附件操作都通过 PomeTodo 自己的命令", async () => {
    const calls: string[] = [];
    const invoke: InvokeCommand = async <T>(command: string) => { calls.push(command); return undefined as T; };
    const service = createTodoServices(invoke);
    await service.listTasks();
    await service.updateTask("test-id", draft);
    await service.setTaskStatus("test-id", "completed");
    await service.setTaskUrgent("test-id", true);
    await service.deleteTask("test-id");
    await service.saveClipboardAttachment();
    await service.getAttachmentDataUrl("opaque.png");
    expect(calls).toEqual([
      "pometodo_list_tasks", "pometodo_update_task", "pometodo_set_status", "pometodo_set_urgent",
      "pometodo_delete_task", "pometodo_save_clipboard_attachment", "pometodo_attachment_data_url",
    ]);
  });
});
