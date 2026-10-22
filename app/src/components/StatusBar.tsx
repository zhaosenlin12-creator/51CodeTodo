import { useEffect, useRef, useState, type ReactNode } from "react";
import "./statusBar.css";

export interface StatusMessage { text: string; tone?: string }
export interface SystemStatusProps { systemMessage?: StatusMessage | null; onDismissSystemMessage?: () => void }

/** 列表和设置共用的单行固定底栏：左侧统计/版本号，右侧一条操作提示；样式只有一份。 */
export default function StatusBar({ children, hint, className = "", message, onDismiss }: {
  children: ReactNode; hint: ReactNode; className?: string; message?: StatusMessage | null; onDismiss?: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!message) { setVisible(false); return; }
    setVisible(false);
    const frame = requestAnimationFrame(() => setVisible(true));
    // 重要提示（警告/错误）停留 7 秒并允许手动关闭；普通提示 3 秒。
    const severe = message.tone === "warn" || message.tone === "error";
    const duration = severe ? 7000 : 3000;
    const closing = setTimeout(() => setVisible(false), duration);
    const closed = setTimeout(() => dismiss.current?.(), duration + 180);
    return () => { cancelAnimationFrame(frame); clearTimeout(closing); clearTimeout(closed); };
  }, [message]);
  return <footer className={`pome-statusbar ${className}`}>
    <div className="pome-statusbar-content" role={message?.tone === "error" ? "alert" : "status"} aria-live="polite" aria-atomic="true">
      {message ? <span className={`pome-status-message ${message.tone ?? "info"}${visible ? " visible" : ""}`} title={message.text}>{message.text}</span> : children}
    </div>
    <span className="pome-statusbar-hint" title={typeof hint === "string" ? hint : undefined}>{hint}</span>
  </footer>;
}
