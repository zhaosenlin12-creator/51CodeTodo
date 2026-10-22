import { describe, expect, it, vi } from "vitest";
import { useServiceExtension } from "./serviceExtension";

describe("默认服务入口", () => {
  it("未配置 Key 时直接引导到智能整理设置，不读取账号", () => {
    const openSettings = vi.fn();
    const value = useServiceExtension({ snapshot: null, busy: false, editorOpen: false, settingsOpen: false, onSnapshot: vi.fn(), refresh: vi.fn(), onMessage: vi.fn(), openSettings });
    expect(value.mode).toBe("byok");
    expect(value.settingsContent).toBeUndefined();
    expect(value.editorContent).toBeUndefined();
    value.openEntry();
    expect(openSettings).toHaveBeenCalledWith("smartArrange");
  });
});
