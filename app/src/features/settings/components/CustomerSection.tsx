import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CustomerSetting } from "../../../contracts/settings";
import { filterCustomers, validateCustomerDisplayName } from "../settingsModel";
import { settingsTexts } from "../settingsTexts";
import { settingsIcons } from "./SettingsIcons";

export interface CustomerRenameCallResult {
  ok: boolean;
  message?: string;
}

interface CustomerSectionProps {
  customers: CustomerSetting[];
  busy: boolean;
  /** 行内改名进行中的客户原名；状态提升以便返回前判断未提交输入。 */
  renamingOriginal: string | null;
  onRenamingChange(original: string | null): void;
  onRename(original: string, displayName: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** 打开移除二次确认，由页面执行。 */
  onRequestRemove(customer: CustomerSetting): void;
}

export default function CustomerSection({
  customers,
  busy,
  renamingOriginal,
  onRenamingChange,
  onRename,
  onRequestRemove,
}: CustomerSectionProps) {
  const [query, setQuery] = useState("");
  const visible = filterCustomers(customers, query);

  return (
    <div className="settings-stack">
      <input
        className="settings-input"
        type="text"
        placeholder={settingsTexts.customerSearchPlaceholder}
        aria-label={settingsTexts.customerGroup}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="settings-customer-list" role="list">
        {visible.length === 0 ? (
          <span className="settings-row-hint">{settingsTexts.customerEmpty}</span>
        ) : (
          visible.map((row) => (
            <div className="settings-customer-row" role="listitem" key={row.originalName}>
              {renamingOriginal === row.originalName ? (
                <CustomerRenameEditor
                  initialName={row.displayName}
                  busy={busy}
                  onCommit={(value) => onRename(row.originalName, value)}
                  onCancel={() => onRenamingChange(null)}
                />
              ) : (
                <>
                  <span className="settings-customer-name" title={row.originalName}>
                    {row.displayName}
                  </span>
                  <span className="settings-customer-count" title={settingsTexts.customerCountHint}>
                    {row.activeCount}
                  </span>
                  <span className="settings-customer-actions">
                    <button
                      className="settings-icon-button"
                      type="button"
                      disabled={busy}
                      aria-label={`${settingsTexts.customerRename} ${row.displayName}`}
                      title={settingsTexts.customerRename}
                      onClick={() => onRenamingChange(row.originalName)}
                    >
                      {settingsIcons.edit}
                    </button>
                    <button
                      className="settings-icon-button danger"
                      type="button"
                      disabled={busy}
                      aria-label={`${settingsTexts.remove} ${row.displayName}`}
                      title={settingsTexts.remove}
                      onClick={() => onRequestRemove(row)}
                    >
                      {settingsIcons.trash}
                    </button>
                  </span>
                </>
              )}
            </div>
          ))
        )}
      </div>
      <span className="settings-row-hint">{settingsTexts.customerRemoveHint}</span>
    </div>
  );
}

interface CustomerRenameEditorProps {
  initialName: string;
  busy: boolean;
  onCommit(displayName: string): Promise<{ ok: true } | { ok: false; message: string }>;
  onCancel(): void;
}

function CustomerRenameEditor({ initialName, busy, onCommit, onCancel }: CustomerRenameEditorProps) {
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
  }, []);

  const commit = async () => {
    if (cancelledRef.current || busy || submitting) return;
    setSubmitting(true);
    try {
      const validation = validateCustomerDisplayName(value);
      if (!validation.ok) {
        setError(validation.error);
        return;
      }
      const result = await onCommit(validation.displayName);
      if (!result.ok) {
        // 服务失败：保留编辑态与输入，便于重试。
        setError(result.message ?? settingsTexts.saveFailed);
        return;
      }
      setError(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (locked) return;
      cancelledRef.current = true;
      onCancel();
    }
  };

  const locked = busy || submitting;

  return (
    <span className="settings-rename-editor">
      <input
        className={`settings-input settings-input-compact${error ? " error" : ""}`}
        value={value}
        disabled={locked}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => void commit()}
        aria-label={settingsTexts.customerRename}
      />
      {error && <span className="settings-field-error">{error}</span>}
    </span>
  );
}
