import { describe, expect, it } from "vitest";
import { statusBarHint } from "./statusHint";

const base = { dialogOpen: false, showingLogin: false, recognizing: false, smartArrangeAvailable: false };

describe("底栏动态提示", () => {
  it("列表页按智能整理状态区分引导", () => {
    expect(statusBarHint({ ...base, smartArrangeAvailable: true })).toBe("Ctrl+N 新增 · Ctrl+V 一键整理");
    expect(statusBarHint(base)).toBe("Ctrl+N 新增 · 试试智能整理");
  });
  it("新增/编辑页提示只保留整理快捷键", () => {
    expect(statusBarHint({ ...base, dialogOpen: true, smartArrangeAvailable: true })).toBe("Ctrl+V 一键整理");
    expect(statusBarHint({ ...base, dialogOpen: true })).toBe("试试智能整理");
  });
  it("扫码、整理中优先于普通提示", () => {
    expect(statusBarHint({ ...base, dialogOpen: true, showingLogin: true })).toBe("请用微信扫码确认");
    expect(statusBarHint({ ...base, dialogOpen: true, recognizing: true, smartArrangeAvailable: true })).toBe("正在整理…");
    expect(statusBarHint({ ...base, recognizing: true })).toBe("正在整理…");
  });
});
