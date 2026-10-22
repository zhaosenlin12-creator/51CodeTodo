/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import StatusBar from "./StatusBar";

describe("共用底栏", () => {
  it("可恢复注意项使用正文加重样式，不再套用错误红色", () => {
    const warn = renderToStaticMarkup(<StatusBar hint="Esc 返回列表" message={{ tone: "warn", text: "网络暂不可用" }}>统计</StatusBar>);
    expect(warn).toContain("pome-status-message warn");
    expect(warn).toContain("网络暂不可用");
    expect(warn).not.toContain("pome-status-message error");
  });
  it("支付异常等真正错误保留红色警示", () => {
    const error = renderToStaticMarkup(<StatusBar hint="Esc 返回列表" message={{ tone: "error", text: "删除失败" }}>统计</StatusBar>);
    expect(error).toContain("pome-status-message error");
  });
  it("右侧提示单行溢出省略且不挤压左侧统计", () => {
    const html = renderToStaticMarkup(<StatusBar hint="Ctrl+N 新增 · Ctrl+V 一键整理">未完成 1</StatusBar>);
    expect(html).toContain("pome-statusbar-hint");
    expect(html).toContain("Ctrl+N 新增 · Ctrl+V 一键整理");
    const css = readFileSync(fileURLToPath(new URL("./statusBar.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.pome-statusbar-hint \{[^}]*white-space: nowrap/);
    expect(css).toMatch(/\.pome-statusbar-hint \{[^}]*text-overflow: ellipsis/);
    expect(css).toMatch(/\.pome-status-message\.warn \{ color: var\(--text-primary\); font-weight: 600; \}/);
  });
});
