import type { BackupImportPreview } from "../../../contracts/settings";
import { settingsTexts } from "../settingsTexts";
import ConfirmDialog from "./ConfirmDialog";

interface BackupSectionProps {
  busy: boolean;
  /** chooseBackupImport 返回的预检结果；null 表示没有待确认的导入。 */
  importPreview: BackupImportPreview | null;
  onImportPreviewChange(preview: BackupImportPreview | null): void;
  onExport(): void;
  onExportMarkdown(): void;
  onChooseImport(): void;
  onConfirmImport(token: string): void;
}

export default function BackupSection({
  busy,
  importPreview,
  onImportPreviewChange,
  onExport,
  onExportMarkdown,
  onChooseImport,
  onConfirmImport,
}: BackupSectionProps) {
  return (
    <div className="settings-stack">
      <div className="settings-button-row">
        <button className="settings-button primary" type="button" disabled={busy} onClick={onExport}>
          {settingsTexts.exportBackup}
        </button>
        <button className="settings-button" type="button" disabled={busy} onClick={onExportMarkdown}>
          {settingsTexts.exportMarkdown}
        </button>
        <button className="settings-button" type="button" disabled={busy} onClick={onChooseImport}>
          {settingsTexts.importBackup}
        </button>
      </div>

      {importPreview && (
        <ConfirmDialog
          title={settingsTexts.importPreviewTitle}
          confirmLabel={settingsTexts.importPreviewConfirm}
          danger
          busy={busy}
          onConfirm={() => onConfirmImport(importPreview.token)}
          onCancel={() => onImportPreviewChange(null)}
        >
          <div className="settings-preview-list">
            <p className="settings-preview-row">
              <span className="settings-preview-label">文件</span>
              <span>{importPreview.fileName}</span>
            </p>
            <p className="settings-preview-row">
              <span className="settings-preview-label">任务</span>
              <span>{importPreview.taskCount} 条</span>
            </p>
            <p className="settings-preview-row">
              <span className="settings-preview-label">附件</span>
              <span>{importPreview.attachmentCount} 个</span>
            </p>
            {importPreview.message && <p className="settings-dialog-message">{importPreview.message}</p>}
            <p className="settings-dialog-message">{settingsTexts.importPreviewMessage}</p>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
