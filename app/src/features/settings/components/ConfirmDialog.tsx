import type { ReactNode } from "react";
import { settingsIcons } from "./SettingsIcons";
import { settingsTexts } from "../settingsTexts";

interface ConfirmDialogProps {
  title: string;
  /** 纯文字说明；复杂内容（目录预览、导入信息）用 children。 */
  message?: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 忙时禁用两个按钮，避免误取消执行中的写入。 */
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** Escape 由页面统一按优先级处理（弹层 → 编辑表单 → 无），不在此处监听。 */
export default function ConfirmDialog({
  title,
  message,
  children,
  confirmLabel,
  cancelLabel = settingsTexts.cancel,
  danger = false,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="settings-dialog-heading">
          <h3 className="settings-dialog-title">{title}</h3>
          <button
            className="settings-dialog-close"
            type="button"
            aria-label={settingsTexts.close}
            disabled={busy}
            onClick={onCancel}
          >
            {settingsIcons.close}
          </button>
        </div>
        {message && <p className="settings-dialog-message">{message}</p>}
        {children}
        <div className="settings-dialog-actions">
          <button className="settings-button" type="button" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`settings-button primary${danger ? " danger" : ""}`}
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
