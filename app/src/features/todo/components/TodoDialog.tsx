import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { TodoDraftFields, TodoQuickDueOption } from "../todoModel";
import {
  dueWordsFor,
  formatTodoDialogDateDisplay,
  parseTodoDialogDateValue,
  toTodoDateOffsetInputValue,
} from "../todoModel";
import { todoTexts } from "../todoTexts";
import { wordPackFor } from "../wordPacks";
import TodoCalendar, { shiftCalendarMonth } from "./TodoCalendar";
import { todoIcons } from "./TodoIcons";
import CustomerInput from "./CustomerInput";
import type { SmartArrangeEntryTone } from "../../../extensions/types";

/** 智能整理按钮的三档视觉权重；整理中保持尺寸只加禁用。 */
export function smartArrangeToneClass(tone: SmartArrangeEntryTone | undefined): string {
  if (tone === "primary") return "tone-primary";
  if (tone === "secondary") return "tone-secondary";
  return "tone-medium";
}

export type TodoDialogDateField = "receivedAt" | "dueAt";

/** 识别剪贴板在按钮上的状态文案；local/empty 不标成 AI 成功。 */
export type TodoRecognitionView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ai" }
  | { kind: "local"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string };

export function todoRecognitionLabel(view: TodoRecognitionView) {
  if (view.kind === "loading") return todoTexts.recognizingClipboard;
  if (view.kind === "ai") return todoTexts.recognizeClipboardSuccess;
  if (view.kind === "local") return todoTexts.localRecognized;
  if (view.kind === "empty") return todoTexts.noClipboardContent;
  if (view.kind === "error") return todoTexts.recognizeClipboardFailure;
  return todoTexts.recognizeClipboard;
}

interface TodoDialogProps {
  editing: boolean;
  draft: TodoDraftFields;
  titleError: boolean;
  recognitionView: TodoRecognitionView;
  /** 识别结果把文字送入备注时递增；备注框短暂蓝框提醒。 */
  notePulse?: number;
  smartArrangeAvailable?: boolean;
  smartArrangeLabel?: string;
  smartArrangeTone?: SmartArrangeEntryTone;
  accountView?: ReactNode;
  quickDueOptions: TodoQuickDueOption[];
  customerSuggestions: string[];
  customerLabel?: string;
  attachmentThumbs: Record<string, string>;
  saving: boolean;
  addingAttachment: boolean;
  onCustomerInput: (value: string) => void;
  onTitleInput: (value: string) => void;
  onNoteInput: (value: string) => void;
  onReceivedInput: (value: string) => void;
  onDueInput: (value: string) => void;
  onReminderInput: (value: string) => void;
  onCategoryInput: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  onRecognize: () => void;
  onImportAttachments: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onOpenAttachment: (path: string) => void;
}

export default function TodoDialog({
  editing,
  draft,
  titleError,
  recognitionView,
  notePulse = 0,
  smartArrangeAvailable = false,
  smartArrangeLabel = "登录体验智能整理",
  smartArrangeTone,
  accountView,
  quickDueOptions,
  customerSuggestions,
  customerLabel = "来源",
  attachmentThumbs,
  saving,
  addingAttachment,
  onCustomerInput,
  onTitleInput,
  onNoteInput,
  onReceivedInput,
  onDueInput,
  onReminderInput,
  onCategoryInput,
  onClose,
  onSave,
  onDelete,
  onRecognize,
  onImportAttachments,
  onRemoveAttachment,
  onOpenAttachment,
}: TodoDialogProps) {
  const pack = wordPackFor(customerLabel);
  const dueWords = dueWordsFor(pack.dueWord);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const noteFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [noteFlash, setNoteFlash] = useState(false);
  const [activeDateField, setActiveDateField] = useState<TodoDialogDateField | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const recognizing = recognitionView.kind === "loading";
  const recognitionLabel = recognizing ? "整理中…" : smartArrangeAvailable ? "粘贴并整理" : smartArrangeLabel;
  const showingAccount = Boolean(accountView);
  const recognizeButton = useRef<HTMLButtonElement>(null);
  const wasShowingAccount = useRef(false);
  useLayoutEffect(() => {
    if (wasShowingAccount.current && !showingAccount) recognizeButton.current?.focus();
    wasShowingAccount.current = showingAccount;
  }, [showingAccount]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const startVoice = () => {
    const w = window as any;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      alert("当前系统浏览器不支持语音输入，请升级 WebView 或使用 Chrome");
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    const baseTitle = draft.title ?? "";
    let finalizedSoFar = "";
    const placeCaret = () => {
      const el = titleRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch {}
      el.scrollLeft = el.scrollWidth;
    };
    rec.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) finalizedSoFar += t;
        else interim += t;
      }
      const combined = (baseTitle ? baseTitle + " " : "") + finalizedSoFar + interim;
      onTitleInput(combined.trim());
      requestAnimationFrame(placeCaret);
    };
    rec.onend = () => {
      setListening(false);
      const finalText = (baseTitle ? baseTitle + " " : "") + finalizedSoFar;
      onTitleInput(finalText.trim());
      requestAnimationFrame(placeCaret);
      if (smartArrangeAvailable && finalizedSoFar.trim()) {
        navigator.clipboard?.writeText(finalText).catch(() => {});
        setTimeout(() => onRecognize(), 500);
      }
    };
    rec.onerror = () => setListening(false);
    rec.start();
    setListening(true);
  };

  // 备注高度随内容自适应（最多约三行，超出内部滚动）；识别回填与手动输入共用。
  useLayoutEffect(() => {
    const element = noteRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 66)}px`;
  }, [draft.note]);

  // 识别文字进入备注时边框短暂变蓝提醒，约 2 秒后淡出（300ms 过渡）。
  useEffect(() => {
    if (notePulse === 0 || noteRef.current === null) return;
    setNoteFlash(true);
    if (noteFlashTimer.current) clearTimeout(noteFlashTimer.current);
    noteFlashTimer.current = setTimeout(() => {
      noteFlashTimer.current = null;
      setNoteFlash(false);
    }, 2000);
    return () => {
      if (noteFlashTimer.current) { clearTimeout(noteFlashTimer.current); noteFlashTimer.current = null; }
    };
  }, [notePulse]);

  const openDatePicker = (field: TodoDialogDateField) => {
    const selected = parseTodoDialogDateValue(draft[field]) ?? new Date();
    setCalendarMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    setActiveDateField(field);
  };

  const handleDateControlKeyDown = (event: KeyboardEvent, field: TodoDialogDateField) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openDatePicker(field);
  };

  const selectDate = (field: TodoDialogDateField, value: string) => {
    if (field === "receivedAt") {
      onReceivedInput(value);
    } else {
      onDueInput(value);
    }
    setActiveDateField(null);
  };

  const applyDueShortcut = (days: number) => {
    onDueInput(toTodoDateOffsetInputValue(days));
    setActiveDateField(null);
  };

  const isDueShortcutActive = (days: number) => {
    return draft.dueAt === toTodoDateOffsetInputValue(days);
  };

  const handleDialogMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!activeDateField) return;

    const target = event.target as HTMLElement;
    if (!target.closest(".todo-dialog-date-field")) {
      setActiveDateField(null);
    }
  };

  const renderCalendar = (field: TodoDialogDateField) => {
    if (activeDateField !== field) return null;
    return (
      <TodoCalendar
        month={calendarMonth}
        onShiftMonth={(offset) => setCalendarMonth((date) => shiftCalendarMonth(date, offset))}
        selectedDate={parseTodoDialogDateValue(draft[field])}
        onSelect={(value) => selectDate(field, value)}
        onClear={field === "dueAt" ? () => selectDate(field, "") : undefined}
        clearLabel={dueWords.clear}
      />
    );
  };

  const renderDateField = (field: TodoDialogDateField, placeholder: string) => (
    <div className="todo-dialog-field todo-dialog-date-field">
      <span className="todo-dialog-label">{field === "receivedAt" ? pack.receivedAtLabel : pack.dueAtLabel}</span>
      <div
        className={`todo-dialog-date-control${activeDateField === field ? " open" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => openDatePicker(field)}
        onKeyDown={(event) => handleDateControlKeyDown(event, field)}
      >
        <input
          className="dialog-input todo-dialog-input todo-dialog-date-input"
          type="text"
          placeholder={placeholder}
          value={formatTodoDialogDateDisplay(draft[field])}
          readOnly
        />
        <span className="todo-dialog-date-icon">{todoIcons.calendar}</span>
      </div>
      {renderCalendar(field)}
    </div>
  );

  const renderAttachments = () => {
    return (
      <div className={`todo-dialog-attachment-section${draggingFiles ? " drag-over" : ""}`}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDraggingFiles(true); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false); }}
        onDrop={event => { event.preventDefault(); setDraggingFiles(false); onImportAttachments(Array.from(event.dataTransfer.files)); }}
        >
        <input ref={fileInput} type="file" hidden multiple accept=".png,.jpg,.jpeg,.bmp,.gif,.webp" onChange={event => {
          onImportAttachments(Array.from(event.target.files ?? []));
          event.target.value = "";
        }} />
          <button
            className="todo-attachment-empty-add-btn"
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={addingAttachment || saving}
            title="点击选择图片，或拖入、粘贴截图"
            aria-label="添加截图"
          >
            {addingAttachment ? todoIcons.spinner : todoIcons.paperclip}<span>{addingAttachment ? "正在添加图片…" : draft.attachmentPaths.length > 0 ? `拖入或点击上传图片 · 当前 ${draft.attachmentPaths.length} 张` : "拖入或点击上传图片"}</span>
          </button>
        {draft.attachmentPaths.length > 0 && <div className="todo-dialog-attachment-row">
          <div className="todo-attachment-thumbnail-list">
            {draft.attachmentPaths.map((path, index) => (
              <div className="todo-attachment-thumbnail-item" key={`${path}-${index}`}>
                <button
                  className="todo-attachment-thumbnail"
                  type="button"
                  onClick={() => onOpenAttachment(path)}
                  aria-label={todoTexts.previewAttachment(index)}
                >
                  {attachmentThumbs[path] ? (
                    <span
                      className="todo-attachment-thumbnail-image"
                      style={{ backgroundImage: `url(${attachmentThumbs[path]})` }}
                    />
                  ) : (
                    <span className="todo-attachment-thumbnail-placeholder">{todoIcons.image}</span>
                  )}
                </button>
                <button
                  className="todo-attachment-thumbnail-remove"
                  type="button"
                  onClick={() => onRemoveAttachment(path)}
                  aria-label={todoTexts.removeAttachment(index)}
                >
                  {todoIcons.close}
                </button>
              </div>
            ))}
          </div>
        </div>}
      </div>
    );
  };

  return (
    <div className="todo-editor-scroll">
      <div className="todo-task-editor" role="region" aria-label={editing ? "编辑待办" : "新增待办"} inert={saving} onMouseDown={handleDialogMouseDown}
        onKeyDown={(event) => {
          if (!showingAccount && event.key === "Escape" && activeDateField) {
            event.stopPropagation();
            setActiveDateField(null);
          }
        }}>
        {showingAccount && <div className="todo-editor-account-view">{accountView}</div>}
        <div className="todo-editor-form-view" hidden={showingAccount} inert={showingAccount || undefined}>
        <div className="todo-dialog-header">
          <h3 className="dialog-title">{editing ? "编辑待办" : "新增待办"}</h3>
          <div className="todo-dialog-header-actions">
            <button
              className={`todo-voice-btn${listening ? " listening" : ""}`}
              type="button"
              onClick={startVoice}
              disabled={saving || addingAttachment}
              aria-label={listening ? "停止语音" : "语音输入"}
              title="说一句话，自动整理成待办"
            >
              <span aria-hidden="true">{listening ? "■" : "🎤"}</span>
              <span>{listening ? "正在听…" : "语音"}</span>
            </button>
            <button ref={recognizeButton} className={`todo-recognize-btn ${smartArrangeToneClass(smartArrangeTone)}`} type="button" onClick={onRecognize} disabled={recognizing || saving || addingAttachment} aria-label={recognitionLabel} title={smartArrangeAvailable ? "读取剪贴板中的文字或截图，自动填写待办" : recognitionLabel}>
              {recognizing ? todoIcons.spinner : todoIcons.clipboard}<span>{recognitionLabel}</span>
            </button>
          </div>
        </div>
        <div className="todo-dialog-form">
          <label className="todo-dialog-label">{pack.customerLabel}</label>
          <CustomerInput value={draft.customerName} suggestions={customerSuggestions} error={false} onChange={onCustomerInput} placeholder={pack.customerPlaceholder} ariaLabel={pack.customerAria} />
          <label className="todo-dialog-field">
            <span className="todo-dialog-label">{pack.titleLabel}</span>
            <input
              className={`dialog-input todo-dialog-input ${titleError || !draft.title.trim() ? "error" : ""}`}
              aria-required="true"
              aria-invalid={!draft.title.trim()}
              placeholder=""
              aria-label={pack.titleLabel}
            ref={(el) => { titleRef.current = el; }}
              value={draft.title}
              onChange={(event) => onTitleInput(event.target.value)}
            />
          </label>
          <div className="todo-dialog-date-grid">
            {renderDateField("receivedAt", "")}
            {renderDateField("dueAt", "")}
          </div>
          <div className="todo-dialog-date-shortcuts">
            {quickDueOptions.map((shortcut) => (
              <button
                key={shortcut.label}
                className={`todo-dialog-date-chip${isDueShortcutActive(shortcut.days) ? " active" : ""}`}
                type="button"
                onClick={() => applyDueShortcut(shortcut.days)}
              >
                {shortcut.label}
              </button>
            ))}

          </div>
          {editing && (
            <label className="todo-dialog-field todo-dialog-reminder-field">
              <span className="todo-dialog-label">提醒时间</span>
              <div className="todo-dialog-reminder-row">
                <input
                  className="dialog-input todo-dialog-input"
                  type="datetime-local"
                  aria-label="提醒时间"
                  value={draft.reminderAt}
                  onChange={(event) => onReminderInput(event.target.value)}
                />
                {draft.reminderAt && (
                  <button
                    className="todo-dialog-reminder-clear"
                    type="button"
                    onClick={() => onReminderInput("")}
                    aria-label="清除提醒"
                    title="清除提醒"
                  >
                    {todoIcons.close}
                  </button>
                )}
              </div>
            </label>
          )}
          <label className="todo-dialog-field">
            <span className="todo-dialog-label">分类</span>
            <input
              className="dialog-input todo-dialog-input"
              type="text"
              placeholder="可选，例如：设计 / 开发 / 客户跟进"
              aria-label="分类"
              value={draft.category}
              onChange={(event) => onCategoryInput(event.target.value)}
            />
          </label>
          <label className="todo-dialog-field">
            <span className="todo-dialog-label">备注</span>
            <textarea
              ref={noteRef}
              rows={1}
              className={`dialog-textarea todo-dialog-note${noteFlash ? " flash" : ""}`}
              placeholder=""
              aria-label={todoTexts.noteLabel}
              value={draft.note}
              onChange={(event) => onNoteInput(event.target.value)}
            />
          </label>
          <span className="todo-dialog-label">附件</span>{renderAttachments()}
        </div>
        <div className="todo-dialog-bottom">
          <div className="todo-dialog-bottom-left">
            {editing && (
              <button
                className="todo-dialog-delete-btn card-delete-btn"
                type="button"
                onClick={onDelete}
                title={todoTexts.delete}
                aria-label={todoTexts.delete}
              >
                {todoIcons.delete}
              </button>
            )}
          </div>
          <div className="dialog-actions">
            <button className="dialog-btn secondary" type="button" onClick={onClose}>
              <span className="todo-control-label">{todoTexts.cancel}</span>
            </button>
            <button className="dialog-btn save" type="button" onClick={onSave} disabled={saving || recognizing || addingAttachment || !draft.title.trim()}>
              <span className="todo-control-label">{saving ? todoTexts.savingLabel : editing ? "保存修改" : "添加任务"}</span>
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
