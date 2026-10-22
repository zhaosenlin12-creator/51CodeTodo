/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import TodoDialog, { smartArrangeToneClass, type TodoRecognitionView } from "./TodoDialog";
import { toTodoDateOffsetInputValue } from "../todoModel";
import type { TodoDraftFields } from "../todoModel";

const draft: TodoDraftFields = { customerName: "", title: "", note: "", receivedAt: toTodoDateOffsetInputValue(0), dueAt: toTodoDateOffsetInputValue(0), reminderAt: "", category: "", attachmentPaths: [] };
const idle: TodoRecognitionView = { kind: "idle" };
function dialogProps(overrides: Partial<Parameters<typeof TodoDialog>[0]> = {}) {
  return {
    editing: false, draft, customerError: false, titleError: false, recognitionView: idle,
    quickDueOptions: [], customerSuggestions: [], attachmentThumbs: {}, saving: false, addingAttachment: false,
    onCustomerInput: () => {}, onTitleInput: () => {}, onNoteInput: () => {}, onReceivedInput: () => {}, onDueInput: () => {}, onReminderInput: () => {}, onCategoryInput: () => {},
    onClose: () => {}, onSave: () => {}, onDelete: () => {}, onRecognize: () => {},
    onImportAttachments: () => {}, onRemoveAttachment: () => {}, onOpenAttachment: () => {},
    ...overrides,
  };
}

describe("新增/编辑页智能整理按钮", () => {
  it("三档视觉权重映射到固定类名，缺省按中等强调", () => {
    expect(smartArrangeToneClass("primary")).toBe("tone-primary");
    expect(smartArrangeToneClass("medium")).toBe("tone-medium");
    expect(smartArrangeToneClass("secondary")).toBe("tone-secondary");
    expect(smartArrangeToneClass(undefined)).toBe("tone-medium");
  });
  it("可用时按钮显示粘贴并整理并带主按钮样式", () => {
    const html = renderToStaticMarkup(<TodoDialog {...dialogProps({ smartArrangeAvailable: true, smartArrangeLabel: "购买次数", smartArrangeTone: "primary" })} />);
    expect(html).toContain("粘贴并整理");
    expect(html).toContain("tone-primary");
    expect(html).not.toContain("购买次数");
  });
  it("未启用时透传服务端状态文案与对应档位", () => {
    const html = renderToStaticMarkup(<TodoDialog {...dialogProps({ smartArrangeLabel: "登录体验智能整理", smartArrangeTone: "medium" })} />);
    expect(html).toContain("登录体验智能整理");
    expect(html).toContain("tone-medium");
    const secondary = renderToStaticMarkup(<TodoDialog {...dialogProps({ smartArrangeLabel: "暂不可用", smartArrangeTone: "secondary" })} />);
    expect(secondary).toContain("暂不可用");
    expect(secondary).toContain("tone-secondary");
  });
  it("整理中保持按钮尺寸、禁用重复点击", () => {
    const html = renderToStaticMarkup(<TodoDialog {...dialogProps({ recognitionView: { kind: "loading" }, smartArrangeAvailable: true, smartArrangeTone: "primary" })} />);
    expect(html).toContain("整理中…");
    expect(html).toMatch(/todo-recognize-btn tone-primary[^>]*disabled/);
  });
  it("按钮覆盖浅深主题的 hover 与键盘焦点样式", () => {
    const css = readFileSync(fileURLToPath(new URL("../todo.css", import.meta.url)), "utf8");
    for (const tone of ["primary", "medium", "secondary"]) {
      expect(css).toMatch(new RegExp(`\\.todo-recognize-btn\\.tone-${tone} \\{`));
      expect(css).toMatch(new RegExp(`\\.todo-recognize-btn\\.tone-${tone}:hover:not\\(:disabled\\) \\{`));
    }
    expect(css).toMatch(/\.todo-dialog-header \.todo-recognize-btn:focus-visible \{/);
    expect(css).toMatch(/\[data-theme="dark"\] \.pometodo-todo \.todo-dialog-header \.todo-recognize-btn\.tone-medium/);
  });
});
