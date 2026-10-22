import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuickDueSetting } from "../../../contracts/settings";
import QuickDueSection, { type QuickDueEditorState } from "./QuickDueSection";

const options: QuickDueSetting[] = [
  { label: "A", days: 0 },
  { label: "B", days: 1 },
  { label: "C", days: 3 },
];

function renderSection(editor: QuickDueEditorState | null) {
  return renderToStaticMarkup(
    <QuickDueSection
      options={options}
      busy={false}
      editor={editor}
      dueWord="交付"
      onEditorChange={() => undefined}
      onCommit={() => Promise.resolve({ ok: true })}
      onRemove={() => undefined}
    />,
  );
}

/** 提取包含指定标记（aria-label 或 class）的整个 button 开标签，避免依赖属性输出顺序。 */
function buttonTag(html: string, marker: string): string {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return "";
  const start = html.lastIndexOf("<button", markerIndex);
  const end = html.indexOf(">", markerIndex);
  return html.slice(start, end + 1);
}

describe("QuickDueSection 渲染", () => {
  it("未编辑时可编辑、删除、添加", () => {
    const html = renderSection(null);

    expect(html).not.toContain("disabled");
  });

  it("编辑期间禁用删除、切换编辑项与添加", () => {
    const html = renderSection({ index: 1, originalLabel: "B" });

    // 删除按钮全部禁用（含正在编辑的项）
    expect(buttonTag(html, `aria-label="移除 A"`)).toContain("disabled");
    expect(buttonTag(html, `aria-label="移除 B"`)).toContain("disabled");
    expect(buttonTag(html, `aria-label="移除 C"`)).toContain("disabled");
    // 切换到其他标签的编辑入口禁用
    expect(buttonTag(html, `aria-label="编辑 A"`)).toContain("disabled");
    expect(buttonTag(html, `aria-label="编辑 C"`)).toContain("disabled");
    // 添加入口禁用
    expect(buttonTag(html, "settings-chip-add")).toContain("disabled");
  });

  it("取消后（editor 为 null）删除与添加恢复可用", () => {
    const html = renderSection(null);

    expect(buttonTag(html, `aria-label="移除 A"`)).not.toContain("disabled");
    expect(buttonTag(html, `aria-label="移除 B"`)).not.toContain("disabled");
    expect(buttonTag(html, `aria-label="编辑 C"`)).not.toContain("disabled");
    expect(buttonTag(html, "settings-chip-add")).not.toContain("disabled");
  });
});
