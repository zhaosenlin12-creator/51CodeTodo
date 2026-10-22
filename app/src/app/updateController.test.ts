import { describe, expect, it, vi } from "vitest";
import { createUpdateController } from "./updateController";
import type { UpdateCheck, UpdateProgress, UpdateServices } from "../contracts/updates";

const upToDate: UpdateCheck = { currentVersion: "0.1.0", channel: "standalone", available: false, release: null };
const newRelease: UpdateCheck = {
  currentVersion: "0.1.0", channel: "standalone", available: true,
  release: { version: "0.2.0", releaseNotes: "修复若干问题", publishedAt: "2026-09-01T00:00:00Z" },
};
function services(overrides: Partial<UpdateServices> = {}, check: UpdateCheck = upToDate): UpdateServices {
  return {
    check: vi.fn(async () => check),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    onProgress: vi.fn(async () => () => {}),
    ...overrides,
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("更新控制器", () => {
  it("主动检查返回结果并写入快照；无新版时不进入下载", async () => {
    const svc = services();
    const core = createUpdateController(svc);
    const detach = core.mount();
    const result = await core.checkManual();
    await settle();
    expect(result).toEqual({ ok: true, check: upToDate });
    expect(core.getSnapshot().check).toEqual(upToDate);
    expect(core.getSnapshot().checking).toBe(false);
    core.download();
    expect(svc.download).not.toHaveBeenCalled();
    detach();
  });

  it("主动检查失败给出简短错误；自动检查失败保持安静", async () => {
    const svc = services({ check: vi.fn(async () => { throw new Error("网络不可用"); }) });
    const core = createUpdateController(svc);
    const detach = core.mount();
    const result = await core.checkManual();
    await settle();
    expect(result.ok).toBe(false);
    expect(core.getSnapshot().manualCheckError).toBe("网络不可用");
    detach();

    const auto = createUpdateController(services({ check: vi.fn(async () => { throw new Error("网络不可用"); }) }));
    const detachAuto = auto.mount();
    auto.checkAuto();
    await settle();
    expect(auto.getSnapshot().manualCheckError).toBeNull();
    expect(auto.getSnapshot().checking).toBe(false);
    detachAuto();
  });

  it("自动检查至少间隔 6 小时，首次立即检查", async () => {
    let clock = 1_000_000;
    const svc = services();
    const core = createUpdateController(svc, () => clock);
    const detach = core.mount();
    core.checkAuto(); await settle();
    expect(svc.check).toHaveBeenCalledTimes(1);
    clock += 5 * 3600_000;
    core.checkAuto(); await settle();
    expect(svc.check).toHaveBeenCalledTimes(1);
    clock += 6 * 3600_000 + 1;
    core.checkAuto(); await settle();
    expect(svc.check).toHaveBeenCalledTimes(2);
    detach();
  });

  it("确认后下载：进度事件驱动状态，ready 后安装一次，卸载解除监听", async () => {
    const capture: { push: ((progress: UpdateProgress) => void) | null } = { push: null };
    const unlisten = vi.fn();
    const svc = services({
      onProgress: vi.fn(async listener => { capture.push = listener; return unlisten; }),
    }, newRelease);
    const core = createUpdateController(svc);
    const detach = core.mount();
    await settle();
    await core.checkManual();
    core.download();
    expect(svc.download).toHaveBeenCalledTimes(1);
    core.download();
    expect(svc.download).toHaveBeenCalledTimes(1);
    capture.push?.({ stage: "downloading", downloadedBytes: 30, totalBytes: 120 });
    expect(core.getSnapshot().download).toBe("downloading");
    expect(core.getSnapshot().progress).toEqual({ stage: "downloading", downloadedBytes: 30, totalBytes: 120 });
    capture.push?.({ stage: "ready", downloadedBytes: 120, totalBytes: 120 });
    expect(core.getSnapshot().download).toBe("ready");
    core.install();
    expect(core.getSnapshot().installing).toBe(true);
    core.install();
    expect(svc.install).toHaveBeenCalledTimes(1);
    detach();
    expect(unlisten).toHaveBeenCalled();
  });

  it("下载失败给出错误并允许重试成功", async () => {
    const download = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("下载中断"))
      .mockResolvedValueOnce(undefined);
    const svc = services({ download }, newRelease);
    const core = createUpdateController(svc);
    const detach = core.mount();
    await core.checkManual();
    core.download(); await settle();
    expect(core.getSnapshot().download).toBe("failed");
    expect(core.getSnapshot().actionError).toBe("下载中断");
    core.download(); await settle();
    expect(core.getSnapshot().download).toBe("ready");
    expect(download).toHaveBeenCalledTimes(2);
    detach();
  });

  it("安装失败回到可安装状态并给出错误", async () => {
    const install = vi.fn(async () => { throw new Error("安装器启动失败"); });
    const svc = services({ install }, newRelease);
    const core = createUpdateController(svc);
    const detach = core.mount();
    await core.checkManual();
    core.download(); await settle();
    expect(core.getSnapshot().download).toBe("ready");
    core.install(); await settle();
    expect(install).toHaveBeenCalledTimes(1);
    expect(core.getSnapshot().installing).toBe(false);
    expect(core.getSnapshot().actionError).toBe("安装器启动失败");
    core.install();
    expect(install).toHaveBeenCalledTimes(2);
    detach();
  });

  it("安装失败后重新检查会同步清掉旧下载状态并允许重新下载", async () => {
    const install = vi.fn(async () => { throw new Error("安装器启动失败"); });
    const download = vi.fn(async () => {});
    const core = createUpdateController(services({ install, download }, newRelease));
    const detach = core.mount();
    await core.checkManual();
    core.download(); await settle();
    core.install(); await settle();
    expect(core.getSnapshot()).toMatchObject({ download: "ready", installing: false, actionError: "安装器启动失败" });

    const checking = core.checkManual();
    expect(core.getSnapshot()).toMatchObject({ download: "idle", progress: null, actionError: null });
    await checking;
    core.download(); await settle();
    expect(download).toHaveBeenCalledTimes(2);
    detach();
  });

  it("重新检查尚未返回时不使用旧版本信息开始下载", async () => {
    let releaseCheck = true;
    const checking = deferred<UpdateCheck>();
    const download = vi.fn(async () => {});
    const svc = services({
      check: vi.fn(() => releaseCheck ? (releaseCheck = false, Promise.resolve(newRelease)) : checking.promise),
      download,
    });
    const core = createUpdateController(svc);
    const detach = core.mount();
    await core.checkManual();
    core.download(); await settle();
    expect(download).toHaveBeenCalledOnce();

    const refreshed = core.checkManual();
    core.download();
    expect(download).toHaveBeenCalledOnce();
    checking.resolve(newRelease);
    await refreshed;
    core.download(); await settle();
    expect(download).toHaveBeenCalledTimes(2);
    detach();
  });

  it("重新检查失败后旧版本不可继续下载，再次检查成功后恢复", async () => {
    const check = vi.fn<() => Promise<UpdateCheck>>()
      .mockResolvedValueOnce(newRelease)
      .mockRejectedValueOnce(new Error("暂时无法检查更新"))
      .mockResolvedValueOnce(newRelease);
    const download = vi.fn(async () => {});
    const core = createUpdateController(services({ check, download }));
    const detach = core.mount();

    await core.checkManual();
    expect(core.getSnapshot().check).toEqual(newRelease);
    expect((await core.checkManual()).ok).toBe(false);
    expect(core.getSnapshot()).toMatchObject({ check: null, manualCheckError: "暂时无法检查更新", download: "idle" });
    core.download(); await settle();
    expect(download).not.toHaveBeenCalled();

    expect((await core.checkManual()).ok).toBe(true);
    core.download(); await settle();
    expect(download).toHaveBeenCalledOnce();
    detach();
  });

  it("StrictMode 清理后立即重新挂载仍能检查并接收进度", async () => {
    const capture: { push: ((progress: UpdateProgress) => void) | null } = { push: null };
    const unlisten = vi.fn();
    const svc = services({
      onProgress: vi.fn(async listener => { capture.push = listener; return unlisten; }),
    }, newRelease);
    const core = createUpdateController(svc);
    const firstDetach = core.mount();
    firstDetach();
    const secondDetach = core.mount();
    await settle();

    expect(await core.checkManual()).toEqual({ ok: true, check: newRelease });
    capture.push?.({ stage: "downloading", downloadedBytes: 12, totalBytes: 24 });
    expect(core.getSnapshot().progress).toEqual({ stage: "downloading", downloadedBytes: 12, totalBytes: 24 });
    secondDetach();
    await settle();
    expect(unlisten).toHaveBeenCalled();
  });

  it("store 渠道发现新版也不调用独立下载安装", async () => {
    const svc = services({}, { ...newRelease, channel: "store" });
    const core = createUpdateController(svc);
    const detach = core.mount();
    await core.checkManual();
    core.download(); await settle();
    expect(svc.download).not.toHaveBeenCalled();
    detach();
  });
});
