import type { AiProvider } from "../../../contracts/settings";
import { settingsTexts } from "../settingsTexts";

const providerOptions: { value: AiProvider; label: string; keyLabel: string }[] = [
  { value: "minimax", label: settingsTexts.aiProviderMinimax, keyLabel: "MiniMax" },
  { value: "deepseek", label: settingsTexts.aiProviderDeepseek, keyLabel: "DeepSeek" },
  { value: "qwen", label: settingsTexts.aiProviderQwen, keyLabel: "Qwen" },
  { value: "glm", label: settingsTexts.aiProviderGlm, keyLabel: "智谱" },
];

interface AiKeySectionProps {
  provider: AiProvider;
  keyConfigured: Record<AiProvider, boolean>;
  busy: boolean;
  /** 当前新 Key 输入；状态提升以便返回前判断未提交输入，切换服务商时清空。 */
  draft: string;
  onDraftChange(value: string): void;
  onProviderChange(provider: AiProvider): void;
  onSaveKey(): void;
  onRequestClearKey(): void;
}

export default function AiKeySection({
  provider,
  keyConfigured,
  busy,
  draft,
  onDraftChange,
  onProviderChange,
  onSaveKey,
  onRequestClearKey,
}: AiKeySectionProps) {
  const configured = keyConfigured[provider];
  const currentProvider = providerOptions.find((item) => item.value === provider) ?? providerOptions[0];

  return (
    <div className="settings-stack">
      <div className="settings-segment settings-key-provider-segment" role="group" aria-label="选择自带 Key 服务商">
        {providerOptions.map((item) => (
          <button
            key={item.value}
            type="button"
            className={keyConfigured[item.value] ? "settings-key-provider-configured" : undefined}
            aria-pressed={provider === item.value}
            aria-label={`${item.label}${keyConfigured[item.value] ? "，Key 已保存" : ""}`}
            title={keyConfigured[item.value] ? `${item.keyLabel} Key 已保存` : undefined}
            disabled={busy}
            onClick={() => onProviderChange(item.value)}
          >
            <span>{item.label}</span>
            {keyConfigured[item.value] && (
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 8 3 3 7-7" />
              </svg>
            )}
          </button>
        ))}
      </div>
      <div className="settings-input-row">
        <input
          className="settings-input settings-input-key"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? `${currentProvider.keyLabel} Key 已保存` : `粘贴 ${currentProvider.keyLabel} API Key`}
          aria-label={`${currentProvider.keyLabel} API Key`}
          value={draft}
          disabled={busy}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSaveKey();
            }
          }}
        />
        <button className="settings-button primary" type="button" disabled={busy} onClick={onSaveKey}>
          {settingsTexts.save}
        </button>
        <button
          className="settings-button"
          type="button"
          disabled={busy}
          title="从剪贴板粘贴"
          onClick={async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) onDraftChange(draft ? draft + text : text);
            } catch {
              alert("读取剪贴板失败，请长按输入框选择粘贴");
            }
          }}
        >
          粘贴
        </button>
        <button
          className="settings-button"
          type="button"
          disabled={busy || !configured}
          data-unavailable={!configured || undefined}
          onClick={onRequestClearKey}
        >
          {settingsTexts.clear}
        </button>
      </div>
    </div>
  );
}
