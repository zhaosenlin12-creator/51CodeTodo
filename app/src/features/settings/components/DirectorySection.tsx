import type { DirectoryChangePreview, DirectoryKind } from "../../../contracts/settings";
import { settingsTexts } from "../settingsTexts";
import { formatDirectoryPath } from "../settingsModel";
import ConfirmDialog from "./ConfirmDialog";

interface DirectorySectionProps {
  dataDirectory: string;
  screenshotDirectory: string;
  busy: boolean;
  /** chooseDirectory 返回的预检结果；null 表示没有待确认的更换。 */
  preview: DirectoryChangePreview | null;
  onPreviewChange(preview: DirectoryChangePreview | null): void;
  onBrowse(kind: DirectoryKind): void;
  onConfirmApply(token: string): void;
}

export default function DirectorySection({
  dataDirectory,
  screenshotDirectory,
  busy,
  preview,
  onPreviewChange,
  onBrowse,
  onConfirmApply,
}: DirectorySectionProps) {
  return (
    <div className="settings-stack">
      <span className="settings-row-title">{settingsTexts.dataDirectoryTitle}</span>
      <div className="settings-input-row">
        <input
          className="settings-input"
          type="text"
          readOnly
          value={formatDirectoryPath(dataDirectory)}
          aria-label={settingsTexts.dataDirectoryTitle}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          className="settings-button"
          type="button"
          disabled={busy}
          onClick={() => onBrowse("data")}
        >
          {settingsTexts.browse}
        </button>
      </div>
      <span className="settings-row-title">{settingsTexts.screenshotDirectoryTitle}</span>
      <div className="settings-input-row">
        <input
          className="settings-input"
          type="text"
          readOnly
          value={formatDirectoryPath(screenshotDirectory)}
          aria-label={settingsTexts.screenshotDirectoryTitle}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          className="settings-button"
          type="button"
          disabled={busy}
          onClick={() => onBrowse("screenshots")}
        >
          {settingsTexts.browse}
        </button>
      </div>

      {preview && (
        <ConfirmDialog
          title={settingsTexts.directoryPreviewTitle}
          confirmLabel={settingsTexts.directoryPreviewConfirm}
          busy={busy}
          onConfirm={() => onConfirmApply(preview.token)}
          onCancel={() => onPreviewChange(null)}
        >
          <div className="settings-preview-list">
            <p className="settings-preview-row">
              <span className="settings-preview-label">来源</span>
              <span>{formatDirectoryPath(preview.source)}</span>
            </p>
            <p className="settings-preview-row">
              <span className="settings-preview-label">目标</span>
              <span>{formatDirectoryPath(preview.destination)}</span>
            </p>
            {preview.message && <p className="settings-dialog-message">{preview.message}</p>}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
