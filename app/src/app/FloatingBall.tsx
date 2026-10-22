import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TodoTask } from "../contracts/todo";
import { getTodoDueInfo } from "../features/todo/todoModel";
import { wordPackFor } from "../features/todo/wordPacks";
import "./floating.css";

/** The preview follows the WPF due/status/update order, independent of urgent flags. */
export function getFloatingTasks(rows: TodoTask[]): TodoTask[] {
  const dueTime = (value: string | null) => {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : Infinity;
  };
  return rows.filter(task => task.status === "pending" || task.status === "in_progress")
    .sort((a, b) => dueTime(a.dueAt) - dueTime(b.dueAt)
      || Number(b.status === "in_progress") - Number(a.status === "in_progress")
      || (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
}

// Emotion Ball SDK：浏览器内按需动态导入（测试/node 环境不执行，避免顶层 window 依赖）
type EmotionBallInstance = { setEmotion: (id: string) => void; destroy: () => void; setActive: (on: boolean) => void };
type EmotionBallFactory = { create: (el: HTMLElement, opts: Record<string, unknown>) => EmotionBallInstance };
let ebPromise: Promise<EmotionBallFactory> | null = null;

function loadEmotionBall() {
  if (!ebPromise) {
    ebPromise = (async () => {
      // 顺序执行：rings（眼环数据）→ emotions（表情）→ ball（身体）→ engine（驱动）
      await import("../assets/emotion-ball/rings.js");
      await import("../assets/emotion-ball/emotions.js");
      await import("../assets/emotion-ball/ball.js");
      await import("../assets/emotion-ball/engine.js");
      const EB = (window as unknown as { EmotionBall?: EmotionBallFactory }).EmotionBall;
      if (!EB) throw new Error("EmotionBall 初始化失败");
      return EB;
    })();
  }
  return ebPromise;
}

/** 按待办状态选表情：全部完成→满意；有逾期→慌张；进行中→忙碌；普通待办→待机。 */
function emotionFor(rows: TodoTask[]): string {
  const open = rows.filter(task => task.status === "pending" || task.status === "in_progress");
  if (open.length === 0) return "19";
  const now = Date.now();
  if (open.some(task => task.dueAt && Date.parse(task.dueAt) < now)) return "17";
  if (open.some(task => task.status === "in_progress")) return "32";
  return "02";
}

export function FloatingBall({ previewOnly = false }: { previewOnly?: boolean }) {
  const [tasks, setTasks] = useState<TodoTask[]>([]);
  const [customerLabel, setCustomerLabel] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [above, setAbove] = useState(false);
  const expandedRef = useRef(false);
  const changing = useRef(false);
  const transitionVersion = useRef(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const ball = useRef<HTMLButtonElement>(null);
  const ebHost = useRef<HTMLSpanElement>(null);
  const ebInstance = useRef<EmotionBallInstance | null>(null);
  const latestEmotion = useRef("02");

  const collapse = useCallback(() => {
    transitionVersion.current += 1;
    expandedRef.current = false;
    setExpanded(false);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    // Only the ball owns the close timer; the preview only plays its fade.
    if (previewOnly) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      void invoke("pometodo_float_expand", { expanded: false })
        .catch(() => setError("浮球未能收起，请重试。"));
    }, 120);
  }, [previewOnly]);
  const requestCollapse = () => { void emit("pometodo-floating-collapse"); };

  useEffect(() => {
    let active = true;
    let refreshVersion = 0;
    let preference = "system";
    const media = matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    };
    const refresh = async () => {
      const version = ++refreshVersion;
      try {
        const [rows, info, settings] = await Promise.all([
          invoke<TodoTask[]>("pometodo_list_tasks"),
          invoke<{ theme: string }>("pometodo_app_info"),
          invoke<{ settings: { customerLabel: string } }>("pometodo_settings_load"),
        ]);
        if (!active || version !== refreshVersion) return;
        preference = info.theme;
        applyTheme();
        setCustomerLabel(settings.settings.customerLabel);
        setTasks(getFloatingTasks(rows));
        setError(null);
      } catch {
        if (active && version === refreshVersion) setError("暂时无法读取待办，请打开主窗口检查。");
      }
    };
    void refresh();
    const present = (payload: boolean) => {
        if (!previewOnly || !active) return;
        if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
        const version = ++transitionVersion.current;
        setAbove(payload);
        setExpanded(false);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!active || version !== transitionVersion.current) return;
          void invoke<boolean>("pometodo_float_present").then(shown => {
            if (!active || version !== transitionVersion.current) return;
            expandedRef.current = shown;
            if (shown) requestAnimationFrame(() => { if (active && version === transitionVersion.current) setExpanded(true); });
          }).catch(() => setError("预览未能显示"));
        }));
      };
    const presentSubscription = listen<boolean>("pometodo-floating-present", ({ payload }) => present(payload));
    const subscriptions = [
      listen("pometodo-floating-refresh", () => void refresh()),
      listen("pometodo-floating-collapse", collapse),
      listen<string>("pometodo-floating-error", ({ payload }) => { if (active) setError(payload); }),
      listen("pometodo-floating-closed", () => { expandedRef.current = false; setExpanded(false); }),
      presentSubscription,
    ];
    const initialVersion = transitionVersion.current;
    if (previewOnly) void Promise.all(subscriptions).then(() => invoke<boolean | null>("pometodo_float_preview_state"))
      .then(value => { if (active && initialVersion === transitionVersion.current && value !== null) present(value); })
      .catch(() => { if (active) setError("预览暂不可用"); });
    for (const subscription of subscriptions) void subscription.catch(() => { if (active) setError("浮球事件连接失败，请重新打开应用。"); });
    const timer = setInterval(() => void refresh(), 30000);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void emit("pometodo-floating-collapse");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    media.addEventListener("change", applyTheme);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("keydown", handleKeyDown);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      media.removeEventListener("change", applyTheme);
      for (const subscription of subscriptions) void subscription.then(unlisten => unlisten()).catch(() => {});
    };
  }, [collapse, previewOnly]);

  // 表情小球挂载（仅收起态浮球窗口，预览窗不挂）
  useEffect(() => {
    if (previewOnly || !ebHost.current) return;
    let alive = true;
    let instance: EmotionBallInstance | null = null;
    loadEmotionBall()
      .then(EB => {
        if (!alive || !ebHost.current) return;
        instance = EB.create(ebHost.current, {
          emotion: latestEmotion.current,
          eyeScale: 1.6,
          lite: true,
          idle: false,
          autostart: true,
        });
        ebInstance.current = instance;
      })
      .catch(() => {});
    return () => {
      alive = false;
      instance?.destroy();
      ebInstance.current = null;
    };
  }, [previewOnly]);

  // 待办状态变化 → 切换表情
  useEffect(() => {
    latestEmotion.current = emotionFor(tasks);
    ebInstance.current?.setEmotion(latestEmotion.current);
  }, [tasks]);

  async function toggle() {
    if (expandedRef.current) { requestCollapse(); return; }
    if (changing.current) return;
    changing.current = true;
    const version = ++transitionVersion.current;
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    try {
      await invoke("pometodo_float_expand", { expanded: true });
      if (version !== transitionVersion.current) return;
      expandedRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (expandedRef.current) setExpanded(true);
      }));
    } catch { setError("浮球未能展开，请从托盘打开待办。"); }
    finally { changing.current = false; }
  }

  async function open(taskId?: string) {
    try {
      await invoke("pometodo_open_main", { taskId: taskId ?? null, settings: false });
      requestCollapse();
    } catch { setError("未能打开待办，请从托盘重试。"); }
  }

  return <div className={`pome-floating-shell${previewOnly ? " preview-only" : ""}${above ? " above" : ""}${expanded ? " expanded" : ""}`}>
    {!previewOnly && <div className="pome-floating-ball-row">
      <button ref={ball} className="pome-floating-ball" aria-expanded={expanded} aria-controls="floating-preview"
        aria-label={`${expanded ? "收起" : "展开"}待办浮球，共 ${tasks.length} 项`}
        onContextMenu={event => {
          event.preventDefault();
          void invoke("pometodo_float_menu").catch(() => setError("浮球菜单未能打开，请从主窗口进入设置。"));
        }}
        onPointerDown={event => {
          if (event.button === 0) {
            drag.current = { x: event.clientX, y: event.clientY, dragged: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (start && event.buttons === 1 && !start.dragged && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 5) {
            start.dragged = true;
            event.currentTarget.releasePointerCapture(event.pointerId);
            void getCurrentWindow().startDragging().catch(() => setError("浮球未能移动，请重试。"));
          }
        }}
        onClick={() => { if (!drag.current?.dragged) void toggle(); drag.current = null; }}>
        <span className="pome-float-shadow" aria-hidden="true" />
        <span className="pome-float-ring" aria-hidden="true" />
        <span ref={ebHost} className="pome-float-face" aria-hidden="true" />
        {tasks.length > 0 && <span className="pome-float-count">{tasks.length}</span>}
      </button>
    </div>}
    {previewOnly && <div className="pome-float-card-layer" inert={!expanded} aria-hidden={!expanded}>
      <div className="pome-float-arrow" />
      <section id="floating-preview" className="pome-float-panel" aria-label="最近待办">
        {error && <p className="pome-float-error" role="alert">{error}</p>}
        <div className="pome-float-tasks">{tasks.slice(0, 3).map(task => {
          const wordPack = wordPackFor(customerLabel ?? undefined);
          const due = getTodoDueInfo(task, new Date(), { today: `今天${wordPack.dueWord}`, tomorrow: `明天${wordPack.dueWord}`, onTime: `按时${wordPack.dueWord}`, late: days => `逾期 ${days} 天${wordPack.dueWord}`, unscheduled: `未设${wordPack.dueWord}日期`, clear: `不设${wordPack.dueWord}日期`, expiringToday: `${wordPack.todayWord}到期` });
          return <button className="pome-float-task" key={task.id} onClick={() => void open(task.id)}>
            <div className="pome-float-task-heading">
              <span className={`pome-float-status ${task.status}`} aria-label={task.status === "in_progress" ? "进行中" : "未完成"} />
              <strong>{task.title}</strong>
              <small className={`pome-float-due ${due?.tone ?? "normal"}`}>{due?.label ?? `未设${wordPack.dueWord}`}</small>
            </div>
            <span className="pome-float-customer">{task.customerName}</span>
          </button>;
        })}</div>
        <button className="pome-float-view-all" onClick={() => void open()}>查看全部 →</button>
      </section>
    </div>}
  </div>;
}
