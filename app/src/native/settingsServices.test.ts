import { describe, expect, it, vi } from "vitest";
import { createSettingsServices } from "./settingsServices";

describe("原生设置接口", () => {
  it("取消文件选择保持 null，确认只传原生预检 token", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const services = createSettingsServices(invoke);
    expect(await services.chooseDirectory("screenshots")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("pometodo_choose_directory", { kind: "screenshots" });
    await services.applyDirectoryChange("native-preview");
    expect(invoke).toHaveBeenLastCalledWith("pometodo_apply_directory", { token: "native-preview" });
    await services.importBackup("backup-preview");
    expect(invoke).toHaveBeenLastCalledWith("pometodo_import_backup", { token: "backup-preview" });
  });
  it("将原生错误作为可读失败返回，不伪装保存成功", async () => {
    const services = createSettingsServices(vi.fn().mockRejectedValue("磁盘空间不足"));
    await expect(services.update({ dailyReminderTime: "10:20" })).rejects.toThrow("磁盘空间不足");
  });
});
