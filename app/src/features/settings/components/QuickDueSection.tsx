import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { QuickDueSetting } from "../../../contracts/settings";
import {
  QUICK_DUE_MAX_LABEL_LENGTH,
  quickDueEditorAfterSubmit,
  type QuickDueEditorSnapshot,
} from "../settingsModel";
import { settingsTexts } from "../settingsTexts";

export interface QuickDueEditorState {
  /** null 表示添加新标签。 */
  index: number | null;
  /** 进入编辑时该位置的标签名；保存时用于确认目标未变，防止数组变化后下标错位。 */
  originalLabel: string;
}

interface QuickDueSectionProps {
  options: QuickDueSetting[];
  busy: boolean;
  editor: QuickDueEditorState | null;
  dueWord: "交付" | "完成";
  onEditorChange(editor: QuickDueEditorState | null): void;
  /** 校验通过后提交全量数组；失败返回 message 供表单内显示。 */
  onCommit(label: string, daysText: string, index: number | null): Promise<{ ok: true } | { ok: false; message: string }>;
  onRemove(index: number): void;
}

export default function QuickDueSection({ options, busy, editor, dueWord, onEditorChange, onCommit, onRemove }: QuickDueSectionProps) {
  const editing = editor !== null;
  const initial = editing && editor.index !== null ? options[editor.index] : undefined;

  return (
    <div className="settings-stack">
      <span className="settings-row-hint">新增任务时这些按钮可一键设置{dueWord}日期</span>
      <div className="settings-chip-list">
        {options.map((item, index) => (
          <span className="settings-chip" key={`${item.label}-${index}`}>
            <button
              className="settings-chip-label"
              type="button"
              disabled={busy || editing}
              data-unavailable={editing || undefined}
              aria-label={`编辑 ${item.label}`}
              title={`${item.days} 天`}
              onClick={() => onEditorChange({ index, originalLabel: item.label })}
            >
              {item.label}
            </button>
            <button
              className="settings-chip-remove"
              type="button"
              disabled={busy || editing || options.length <= 1}
              data-unavailable={editing || options.length <= 1 || undefined}
              aria-label={`${settingsTexts.remove} ${item.label}`}
              title={
                editing
                  ? "编辑期间不能移除标签"
                  : options.length > 1
                    ? settingsTexts.remove
                    : settingsTexts.quickDueRemoveDenied
              }
              onClick={() => onRemove(index)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          className="settings-chip settings-chip-add"
          type="button"
          disabled={busy || editing}
          data-unavailable={editing || undefined}
          onClick={() => onEditorChange({ index: null, originalLabel: "" })}
        >
          {settingsTexts.quickDueAdd}
        </button>
      </div>
      {editing && (
        <QuickDueEditor
          key={editor.index === null ? "add" : `edit-${editor.index}`}
          initialLabel={initial?.label ?? ""}
          initialDays={initial ? `${initial.days}` : "1"}
          editingIndex={editor.index}
          busy={busy}
          onCommit={onCommit}
          onCancel={() => onEditorChange(null)}
        />
      )}
    </div>
  );
}

interface QuickDueEditorProps {
  initialLabel: string;
  initialDays: string;
  editingIndex: number | null;
  busy: boolean;
  onCommit(label: string, daysText: string, index: number | null): Promise<{ ok: true } | { ok: false; message: string }>;
  onCancel(): void;
}

function QuickDueEditor({ initialLabel, initialDays, editingIndex, busy, onCommit, onCancel }: QuickDueEditorProps) {
  const [editor, setEditor] = useState<QuickDueEditorSnapshot>({
    label: initialLabel,
    days: initialDays,
    error: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const locked = busy || submitting;

  const submit = async () => {
    if (locked) return;
    setSubmitting(true);
    try {
      const result = await onCommit(editor.label, editor.days, editingIndex);
      // 失败保留输入并显示错误；成功由页面关闭编辑器（组件卸载）。
      setEditor((current) =>
        quickDueEditorAfterSubmit({ label: current.label, days: current.days, error: current.error }, result),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!locked) onCancel();
    }
  };

  return (
    <form className="settings-inline-editor" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
      <span className="settings-row-title">
        {editingIndex === null ? "添加日期标签" : "编辑日期标签"}
      </span>
      <div className="settings-inline-grid">
        <label className="settings-field">
          <span className="settings-row-hint">{settingsTexts.quickDueLabelField}</span>
          <input
            className={`settings-input${editor.error ? " error" : ""}`}
            value={editor.label}
            maxLength={QUICK_DUE_MAX_LABEL_LENGTH + 4}
            disabled={locked}
            onChange={(event) => setEditor((current) => ({ ...current, label: event.target.value, error: null }))}
          />
        </label>
        <label className="settings-field settings-field-days">
          <span className="settings-row-hint">{settingsTexts.quickDueDaysField}</span>
          <input
            className="settings-input settings-input-center"
            value={editor.days}
            inputMode="numeric"
            disabled={locked}
            onChange={(event) => setEditor((current) => ({ ...current, days: event.target.value, error: null }))}
          />
        </label>
      </div>
      {editor.error && <span className="settings-field-error">{editor.error}</span>}
      <div className="settings-inline-actions">
        <button className="settings-button" type="button" disabled={locked} onClick={onCancel}>
          {settingsTexts.cancel}
        </button>
        <button className="settings-button primary" type="submit" disabled={locked}>
          {editingIndex === null ? settingsTexts.add : settingsTexts.save}
        </button>
      </div>
    </form>
  );
}
