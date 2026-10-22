import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SmartArrangeSnapshot } from "../../../contracts/smartArrange";
import SmartArrangeSection from "./SmartArrangeSection";

function renderSection(snapshot: SmartArrangeSnapshot) {
  return renderToStaticMarkup(
    <SmartArrangeSection snapshot={snapshot} busy={false} onChange={() => undefined}>
      <div>自带 Key 配置表单</div>
    </SmartArrangeSection>,
  );
}

describe("SmartArrangeSection 渐进展示", () => {
  it("不提供官方服务时，直接显示 Key 设置而不显示服务来源", () => {
    const html = renderToStaticMarkup(<SmartArrangeSection
      officialServicesEnabled={false}
      snapshot={{ preferences: { enabled: false, source: "byok" }, available: false, message: "智能整理已关闭" }}
      busy={false} onChange={() => undefined}>
      <div>自带 Key 配置表单</div>
    </SmartArrangeSection>);
    expect(html).toContain("自带 Key 配置表单");
    expect(html).not.toContain("服务来源");
    expect(html).not.toContain("官方服务");
  });

  it("关闭时只显示启用开关和简短说明", () => {
    const html = renderSection({
      preferences: { enabled: false, source: "official" },
      available: false,
      message: "官方服务暂未配置，请使用自带 Key 或手动记录",
    });

    expect(html).toContain("启用智能整理");
    expect(html).toContain("开启后，粘贴文字或截图会自动填写待办");
    expect(html).not.toContain("服务来源");
    expect(html).not.toContain("官方服务");
    expect(html).not.toContain("自带 Key 配置表单");
  });

  it("启用官方服务时默认收起；Key 配置内容禁用不可交互", () => {
    const html = renderSection({
      preferences: { enabled: true, source: "official" },
      available: true,
      message: "智能整理可用",
    });

    expect(html).toContain("服务来源");
    expect(html).toContain("官方服务");
    expect(html).toContain("自带 Key");
    // 官方服务视图不渲染自带 Key 配置内容。
    expect(html).not.toContain("自带 Key 配置表单");
  });

  it("启用自带 Key 时显示 Key 配置", () => {
    const html = renderSection({
      preferences: { enabled: true, source: "byok" },
      available: true,
      message: "DeepSeek Key 可用",
    });

    expect(html).toContain("服务来源");
    expect(html).toContain("自带 Key 配置表单");
  });
});
