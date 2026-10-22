import type { UpdateCheck, UpdateProgress, UpdateServices } from "../contracts/updates";

export interface UpdateState {
  check: UpdateCheck | null;
  checking: boolean;
  /** 主动检查失败才提示；启动与焦点的自动检查失败保持安静。 */
  manualCheckError: string | null;
  download: "idle" | "downloading" | "failed" | "ready";
  installing: boolean;
  progress: UpdateProgress | null;
  actionError: string | null;
}

const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export type UpdateCheckResult = { ok: true; check: UpdateCheck } | { ok: false; error: string };

export function createUpdateController(services: UpdateServices, now: () => number = Date.now) {
  let state: UpdateState = { check: null, checking: false, manualCheckError: null, download: "idle", installing: false, progress: null, actionError: null };
  const listeners = new Set<() => void>();
  let mounted = 0, closed = false, unlisten: (() => void) | null = null;
  let listenGeneration = 0, listening = false;
  let lastCheckAt: number | null = null;
  const live = () => mounted > 0 && !closed;
  function update(patch: Partial<UpdateState>) { if (!live()) return; state = { ...state, ...patch }; listeners.forEach(fn => fn()); }
  function startProgressListener() {
    if (unlisten || listening) return;
    const generation = ++listenGeneration;
    listening = true;
    void services.onProgress(progress => {
      if (!live() || generation !== listenGeneration) return;
      update({
        progress,
        ...(progress.stage === "downloading" ? { download: "downloading" as const } : {}),
        ...(progress.stage === "ready" ? { download: "ready" as const } : {}),
        ...(progress.stage === "installing" ? { installing: true } : {}),
      });
    }).then(fn => {
      if (!live() || generation !== listenGeneration) { fn(); return; }
      unlisten = fn;
    }).catch(() => {}).finally(() => { if (generation === listenGeneration) listening = false; });
  }
  function stopProgressListener() {
    listenGeneration++;
    listening = false;
    const stop = unlisten;
    unlisten = null;
    stop?.();
  }
  async function runCheck(mode: "auto" | "manual"): Promise<UpdateCheckResult> {
    if (!live() || state.checking) return { ok: false, error: "正在检查更新" };
    if (state.download === "downloading" || state.installing) return { ok: false, error: state.installing ? "正在安装更新" : "正在下载更新" };
    update({ check: null, checking: true, download: "idle", progress: null, actionError: null, ...(mode === "manual" ? { manualCheckError: null } : {}) });
    try {
      const check = await services.check();
      if (!live()) return { ok: false, error: "检查已取消" };
      lastCheckAt = now();
      update({ check, checking: false });
      return { ok: true, check };
    } catch (error) {
      const message = errorText(error, "检查更新失败，请稍后重试");
      if (!live()) return { ok: false, error: message };
      update({ checking: false, ...(mode === "manual" ? { manualCheckError: message } : {}) });
      return { ok: false, error: message };
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    mount() {
      if (mounted === 0) closed = false;
      mounted++;
      startProgressListener();
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        mounted = Math.max(0, mounted - 1);
        if (mounted === 0) { closed = true; stopProgressListener(); }
      };
    },
    /** 启动与窗口恢复焦点时的安静检查；两次自动检查至少间隔 6 小时。 */
    checkAuto() {
      if (lastCheckAt !== null && now() - lastCheckAt < AUTO_CHECK_INTERVAL_MS) return;
      void runCheck("auto");
    },
    checkManual() { return runCheck("manual"); },
    download() {
      if (!live() || state.checking || state.download === "downloading" || state.download === "ready" || state.installing) return;
      // 无新版或商店渠道时不调用独立 EXE 下载安装。
      if (!state.check?.available || !state.check.release || state.check.channel === "store") return;
      update({ download: "downloading", progress: null, actionError: null });
      services.download().then(() => { if (live()) update({ download: "ready" }); })
        .catch(error => { if (live()) update({ download: "failed", actionError: errorText(error, "下载失败，请稍后重试") }); });
    },
    install() {
      if (!live() || state.checking || state.installing || state.download !== "ready") return;
      update({ installing: true, actionError: null });
      services.install().catch(error => { if (live()) update({ installing: false, actionError: errorText(error, "启动安装失败，请重试") }); });
    },
  };
}

export type UpdateController = ReturnType<typeof createUpdateController>;
