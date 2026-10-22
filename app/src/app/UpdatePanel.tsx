import { useEffect, useSyncExternalStore } from "react";
import type { UpdateController } from "./updateController";
import "./updates.css";

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export interface UpdatePanelProps {
  controller: UpdateController;
  /** 有未结束的草稿、保存、识别、登录或付款时为 false，禁止启动安装。 */
  canInstall: boolean;
  onBack(): void;
}

/** 主窗口内的更新视图：更新说明 + 立即更新；安装需要用户再次确认。 */
export default function UpdatePanel({ controller, canInstall, onBack }: UpdatePanelProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onBack();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onBack]);
  const release = state.check?.available ? state.check.release : null;
  const progress = state.progress;
  const percent = progress?.totalBytes ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : null;
  return <section className="update-panel" aria-label="软件更新">
    <header className="update-header">
      <h2>软件更新</h2>
      <button className="update-button update-back" type="button" onClick={onBack}>返回列表</button>
    </header>
    <div className="update-content">
      {!state.check ? <p className="update-hint" role="status">正在检查更新…</p>
        : !release ? <p className="update-hint" role="status">当前已是最新版本 v{state.check.currentVersion}</p>
        : <>
          <p className="update-version">发现新版本 v{release.version}<span>当前 v{state.check.currentVersion}</span></p>
          <p className="update-date">{Number.isFinite(Date.parse(release.publishedAt)) ? `发布于 ${new Date(release.publishedAt).toLocaleDateString("zh-CN")}` : null}</p>
          {release.releaseNotes && <pre className="update-notes">{release.releaseNotes}</pre>}
          {state.check.channel === "store" ? <p className="update-hint">当前为商店渠道，请前往应用商店获取更新。</p>
            : <>
              {state.download === "idle" && <button className="update-button update-primary" type="button" onClick={() => controller.download()}>立即更新</button>}
              {state.download === "downloading" && <div className="update-progress" role="status">
                <div className="update-progress-track"><span style={{ width: percent === null ? "100%" : `${percent}%` }} className={percent === null ? "indeterminate" : ""} /></div>
                <span className="update-progress-text">{percent === null ? `已下载 ${formatBytes(progress?.downloadedBytes ?? 0)}` : `${percent}%${progress?.totalBytes ? ` · ${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}` : ""}`}</span>
              </div>}
              {state.download === "ready" && <>
                <button className="update-button update-primary" type="button" disabled={!canInstall || state.installing} onClick={() => controller.install()}>{state.installing ? "正在启动安装器…" : "立即安装"}</button>
                {!canInstall && !state.installing && <p className="update-hint" role="status">请先保存或关闭待办，并等待当前操作结束后再安装。</p>}
                {state.installing && <p className="update-hint" role="status">更新后自动打开。</p>}
              </>}
              {state.download === "failed" && <button className="update-button update-primary" type="button" onClick={() => controller.download()}>重试下载</button>}
            </>}
          {state.actionError && <p className="update-error" role="alert">{state.actionError}</p>}
        </>}
    </div>
  </section>;
}
