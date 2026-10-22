import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsGroup from "./SettingsGroup";

describe("SettingsGroup 渲染", () => {
  it("非折叠组始终渲染标题与内容", () => {
    const html = renderToStaticMarkup(
      <SettingsGroup title="外观">
        <p data-testid="body-content">主题选项</p>
      </SettingsGroup>,
    );

    expect(html).toContain("外观");
    expect(html).toContain("主题选项");
    expect(html).toContain("settings-card-body");
  });

  it("可折叠组默认隐藏且不能交互，保留内容供收起动画", () => {
    const html = renderToStaticMarkup(
      <SettingsGroup title="高级" collapsible>
        <p>高级内容</p>
      </SettingsGroup>,
    );

    expect(html).toContain("高级");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
    expect(html).toContain("高级内容");
  });

  it("可折叠组展开时渲染内容", () => {
    const html = renderToStaticMarkup(
      <SettingsGroup title="高级" collapsible defaultOpen>
        <p>高级内容</p>
      </SettingsGroup>,
    );

    expect(html).toContain("高级内容");
  });

  it("默认展开与可折叠分组共用同一条标题内容分隔线", () => {
    const openHtml = renderToStaticMarkup(<SettingsGroup title="外观"><p>主题</p></SettingsGroup>);
    const collapsibleHtml = renderToStaticMarkup(<SettingsGroup title="数据与备份" collapsible><p>目录</p></SettingsGroup>);

    expect(openHtml).toContain("settings-card-title-divider");
    expect(collapsibleHtml).toContain("settings-card-title-divider");
  });
});
