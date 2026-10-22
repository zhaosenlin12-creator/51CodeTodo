import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type {
  AiProvider,
  AppSettings,
  BackupImportPreview,
  DirectoryChangePreview,
  DirectoryKind,
  SettingsPageProps,
  SettingsTheme,
} from "../../contracts/settings";
import type { SyncConfigSnapshot, SyncServices } from "../../contracts/sync";
import AiKeySection from "./components/AiKeySection";
import SmartArrangeSection, { type SmartArrangeSettingsProps } from "./components/SmartArrangeSection";
import BackupSection from "./components/BackupSection";
import SyncSection from "./components/SyncSection";
import ConfirmDialog from "./components/ConfirmDialog";
import CustomerSection from "./components/CustomerSection";
import DirectorySection from "./components/DirectorySection";
import QuickDueSection, { type QuickDueEditorState } from "./components/QuickDueSection";
import SettingsGroup from "./components/SettingsGroup";
import SettingsRow from "./components/SettingsRow";
import ToggleSwitch from "./components/ToggleSwitch";
import StatusBar, { type SystemStatusProps } from "../../components/StatusBar";
import {
  canRemoveQuickDueOption,
  hasUnsavedSettingsInput,
  parseReminderTimeInput,
  planQuickDueCommit,
  validateCustomerDisplayName,
  type QuickDueEditorTarget,
} from "./settingsModel";
import { settingsTexts } from "./settingsTexts";
import { sceneChoices, sceneValue, wordPackFor } from "../todo/wordPacks";
import { useSettingsController } from "./useSettingsController";
import "./settings.css";

/** 场景切换分段控件：选中指示器在工作/生活/学习之间平滑滑动。 */
function SceneSegment({ label, choices, value, disabled, onChange }: {
  label: string;
  choices: readonly string[];
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const index = choices.indexOf(value);
  useEffect(() => {
    const el = refs.current[index];
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [index, choices]);
  return (
    <div className="settings-segment sliding-segment" role="group" aria-label={label}>
      {thumb && <span className="sliding-segment-thumb" style={{ left: thumb.left, width: thumb.width }} aria-hidden="true" />}
      {choices.map((choice, i) => (
        <button
          key={choice}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          aria-pressed={value === choice}
          disabled={disabled}
          onClick={() => onChange(choice)}
        >
          {choice}
        </button>
      ))}
    </div>
  );
}

/** 场景胶囊 → 设置值（对象字段名）的映射；设置里持久化的是字段名。 */
const sceneToCustomerLabel: Record<string, string> = { 工作: "来源", 生活: "事项", 学习: "主题" };

const GROUP_OPEN_STORAGE_KEY = "pometodo-settings-group-open";

function loadGroupOpenState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_OPEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveGroupOpenState(state: Record<string, boolean>) {
  try {
    localStorage.setItem(GROUP_OPEN_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时保持会话内记忆即可。
  }
}

export type SettingsPageComponent = (props: SettingsPageProps) => ReactElement;

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): Promise<void> | void;
}

const themeOptions = [
  { value: "system", label: settingsTexts.themeSystem },
  { value: "light", label: settingsTexts.themeLight },
  { value: "dark", label: settingsTexts.themeDark },
] as const;

const closeActionOptions = [
  { value: "tray", label: settingsTexts.closeActionTray, hint: settingsTexts.closeActionTrayHint },
  { value: "exit", label: settingsTexts.closeActionExit, hint: settingsTexts.closeActionExitHint },
] as const;

export function isSmartArrangeInteractionBusy(settingsBusy: boolean, smartArrangeBusy: boolean): boolean {
  return settingsBusy || smartArrangeBusy;
}

export function isSettingsInteractionAllowed(settingsBusy: boolean, smartArrangeBusy: boolean): boolean {
  return !isSmartArrangeInteractionBusy(settingsBusy, smartArrangeBusy);
}

interface ReminderSettingsProps {
  enabled: boolean;
  timeInput: string;
  error: string | null;
  busy: boolean;
  dueWord: "交付" | "完成";
  onEnabledChange(enabled: boolean): void;
  onTimeInputChange(value: string): void;
  onCommit(): void;
}

/** 每日提醒关闭时只保留开关，避免为普通用户常驻无效的时间设置。 */
export function ReminderSettings({
  enabled,
  timeInput,
  error,
  busy,
  dueWord,
  onEnabledChange,
  onTimeInputChange,
  onCommit,
}: ReminderSettingsProps): ReactElement {
  return (
    <>
      <SettingsRow
        title={settingsTexts.reminderEnabledTitle}
        hint={`到点弹出系统通知，汇总当天待${dueWord}数量`}
        control={
          <ToggleSwitch
            label={settingsTexts.reminderEnabledTitle}
            checked={enabled}
            disabled={busy}
            onToggle={onEnabledChange}
          />
        }
      />
      {enabled && (
        <>
          <SettingsRow
            title={settingsTexts.reminderTimeTitle}
            hint={`每天此时通知「今天有 N 个任务待${dueWord}」`}
            control={
              <input
                className={`settings-input settings-input-time${error ? " error" : ""}`}
                type="text"
                inputMode="numeric"
                placeholder={settingsTexts.reminderTimePlaceholder}
                aria-label={settingsTexts.reminderTimeTitle}
                value={timeInput}
                maxLength={5}
                disabled={busy}
                onChange={(event) => onTimeInputChange(event.target.value)}
                onBlur={onCommit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onCommit();
                  }
                }}
              />
            }
          />
          {error && <span className="settings-field-error">{error}</span>}
        </>
      )}
    </>
  );
}

export default function SettingsPage({ services, onBack, onChanged, floatingBallEnabled, systemMessage, onDismissSystemMessage, smartArrange, accountCard, hint, onCheckUpdate, updateChecking = false, activeTheme, active = true, settingsFocusRequest, sync }: SettingsPageProps & SystemStatusProps & { floatingBallEnabled?: boolean; smartArrange?: SmartArrangeSettingsProps; accountCard?: ReactNode; hint?: string; onCheckUpdate?: () => void; updateChecking?: boolean; activeTheme?: SettingsTheme; active?: boolean; settingsFocusRequest?: { seq: number; target: string } | null; sync?: { services: SyncServices; onSnapshot(snapshot: SyncConfigSnapshot): void } }): ReactElement {
  const { core, state } = useSettingsController(services, { onSnapshotApplied: onChanged });

  const [reminderTimeInput, setReminderTimeInput] = useState("");
  const [reminderTimeError, setReminderTimeError] = useState<string | null>(null);
  const [reminderTimeLoaded, setReminderTimeLoaded] = useState(false);
  const smartArrangeRef = useRef<HTMLElement | null>(null);
  const [smartArrangeFocusActive, setSmartArrangeFocusActive] = useState(false);
  // 分组折叠状态记忆：记录用户习惯（本机 localStorage，不入库）。
  const [groupOpenState, setGroupOpenState] = useState<Record<string, boolean>>(loadGroupOpenState);
  const groupOpen = useCallback((key: string, fallback: boolean) => groupOpenState[key] ?? fallback, [groupOpenState]);
  const setGroupOpen = useCallback((key: string, open: boolean) => {
    setGroupOpenState(current => {
      const next = { ...current, [key]: open };
      saveGroupOpenState(next);
      return next;
    });
  }, []);
  const [smartArrangeOpen, setSmartArrangeOpen] = useState(false);
  const quickDueRef = useRef<HTMLElement | null>(null);
  const handledFocusSeqRef = useRef(-1);
  const pendingFocusRef = useRef<{ seq: number; target: string } | null>(null);
  const glowTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!settingsFocusRequest || settingsFocusRequest.seq <= handledFocusSeqRef.current) return;
    // 等待设置就绪（账户/快照加载完成）后再定位；未就绪挂起待 phase 变化重进。
    if (state.phase !== "ready") { pendingFocusRef.current = settingsFocusRequest; return; }
    pendingFocusRef.current = null;
    handledFocusSeqRef.current = settingsFocusRequest.seq;
    setGroupOpen(settingsFocusRequest.target, true);
    setSmartArrangeFocusActive(true);
    const target = settingsFocusRequest.target === "quickDue" ? quickDueRef.current : smartArrangeRef.current;
    const scrollOnce = () => target?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timerOne = window.setTimeout(scrollOnce, 250);
    const timerTwo = window.setTimeout(scrollOnce, 800);
    const timerThree = window.setTimeout(scrollOnce, 1500);
    if (glowTimerRef.current) window.clearTimeout(glowTimerRef.current);
    glowTimerRef.current = window.setTimeout(() => {
      glowTimerRef.current = null;
      setSmartArrangeFocusActive(false);
    }, 2400);
    return () => { window.clearTimeout(timerOne); window.clearTimeout(timerTwo); window.clearTimeout(timerThree); };
  }, [settingsFocusRequest, state.phase]);
  useEffect(() => () => { if (glowTimerRef.current) window.clearTimeout(glowTimerRef.current); }, []);
  const [keyDraft, setKeyDraft] = useState("");
  const [quickDueEditor, setQuickDueEditor] = useState<QuickDueEditorState | null>(null);
  const [renamingCustomer, setRenamingCustomer] = useState<string | null>(null);
  const [directoryPreview, setDirectoryPreview] = useState<DirectoryChangePreview | null>(null);
  const [importPreview, setImportPreview] = useState<BackupImportPreview | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const busy = state.busy;
  const interactionBusy = isSmartArrangeInteractionBusy(busy, smartArrange?.busy ?? false);
  const snapshot = state.snapshot;
  const settings = snapshot?.settings ?? null;
  const pack = wordPackFor(settings?.customerLabel);

  // 首次就绪时用服务值初始化提醒时间输入；之后的 snapshot 更新不清空正在编辑的输入。
  useEffect(() => {
    if (state.phase === "ready" && !reminderTimeLoaded && snapshot) {
      setReminderTimeInput(snapshot.settings.dailyReminderTime);
      setReminderTimeLoaded(true);
    }
  }, [reminderTimeLoaded, snapshot, state.phase]);

  const applyUpdate = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (interactionBusy) return;
      await core.update(patch);
    },
    [core, interactionBusy],
  );

  const commitReminderTime = useCallback(async () => {
    if (!snapshot || !settings) return;
    if (!settings.dailyReminderEnabled || interactionBusy) return;
    const parsed = parseReminderTimeInput(reminderTimeInput);
    if (!parsed.ok) {
      // 非法值保留输入并提示，不静默纠正，也不提交服务。
      setReminderTimeError(parsed.error);
      return;
    }
    if (parsed.normalized === settings.dailyReminderTime) {
      setReminderTimeError(null);
      return;
    }
    const result = await core.update({ dailyReminderTime: parsed.normalized });
    if (!result.ok) {
      setReminderTimeError(result.message);
      return;
    }
    setReminderTimeError(null);
    setReminderTimeInput(result.value.settings.dailyReminderTime);
  }, [core, interactionBusy, reminderTimeInput, settings, snapshot]);

  const commitScene = useCallback(
    async (scene: string) => {
      if (!settings || interactionBusy) return;
      const label = sceneToCustomerLabel[scene];
      if (!label || label === settings.customerLabel) return;
      await applyUpdate({ customerLabel: label });
    },
    [settings, interactionBusy, applyUpdate],
  );

  const quickDueCommit = useCallback(
    async (
      label: string,
      daysText: string,
      index: number | null,
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (!settings) return { ok: false, message: settingsTexts.saveFailed };
      if (interactionBusy) return { ok: false, message: settingsTexts.actionBusy };
      // 编辑时用进入编辑时的原始标签确认目标未变；数组已变化时判定过期，不覆盖另一项。
      let target: QuickDueEditorTarget | null = null;
      if (index !== null) {
        if (quickDueEditor === null || quickDueEditor.index !== index) {
          return { ok: false, message: settingsTexts.quickDueStale };
        }
        target = { index, originalLabel: quickDueEditor.originalLabel };
      }
      const plan = planQuickDueCommit(settings.quickDueOptions, label, daysText, target);
      if (plan.kind !== "save") return { ok: false, message: plan.error };
      const result = await core.update({ quickDueOptions: plan.options });
      if (!result.ok) return { ok: false, message: result.message };
      setQuickDueEditor(null);
      return { ok: true };
    },
    [core, interactionBusy, quickDueEditor, settings],
  );

  const quickDueRemove = useCallback(
    (index: number) => {
      if (!settings || interactionBusy) return;
      if (quickDueEditor) return; // 编辑期间不允许改变数组的操作
      if (!canRemoveQuickDueOption(settings.quickDueOptions)) return;
      const next = settings.quickDueOptions.filter((_, item) => item !== index);
      void core.update({ quickDueOptions: next });
    },
    [core, interactionBusy, quickDueEditor, settings],
  );

  const renameCustomer = useCallback(
    async (
      original: string,
      displayName: string,
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (interactionBusy) return { ok: false, message: settingsTexts.actionBusy };
      const validation = validateCustomerDisplayName(displayName);
      if (!validation.ok) return { ok: false, message: validation.error };
      const result = await core.renameCustomer(original, validation.displayName);
      if (!result.ok) return { ok: false, message: result.message };
      setRenamingCustomer(null);
      core.setMessage({ tone: "success", text: settingsTexts.customerRenameSaved });
      return { ok: true };
    },
    [core, interactionBusy],
  );

  const requestRemoveCustomer = useCallback(
    (customer: { originalName: string; displayName: string }) => {
      if (interactionBusy) return;
      setConfirm({
        title: settingsTexts.customerRemoveConfirmTitle,
        message: settingsTexts.customerRemoveConfirmMessage(customer.displayName),
        confirmLabel: settingsTexts.remove,
        danger: true,
        onConfirm: async () => {
          if (interactionBusy) return;
          const result = await core.hideCustomer(customer.originalName);
          if (result.ok) {
            setConfirm(null);
            core.setMessage({ tone: "success", text: settingsTexts.customerRemoved });
          }
          // 失败保留弹层以便重试；错误已显示。
        },
      });
    },
    [core, interactionBusy],
  );

  const handleProviderChange = useCallback(
    (provider: AiProvider) => {
      if (interactionBusy) return;
      setKeyDraft("");
      void applyUpdate({ aiProvider: provider });
    },
    [applyUpdate, interactionBusy],
  );

  const saveApiKey = useCallback(() => {
    if (interactionBusy) return;
    const key = keyDraft.trim();
    if (!key) {
      core.setMessage({ tone: "error", text: settingsTexts.apiKeyRequired });
      return;
    }
    void (async () => {
      const provider = settings?.aiProvider;
      if (!provider) return;
      const result = await core.saveApiKey(provider, key);
      if (result.ok) {
        setKeyDraft("");
        core.setMessage({ tone: "success", text: settingsTexts.apiKeySaved });
        const preferences = smartArrange?.snapshot?.preferences;
        if (preferences && (!preferences.enabled || preferences.source !== "byok")) {
          smartArrange.onChange({ enabled: true, source: "byok" });
        }
      }
      // 失败保留输入便于重试；错误已显示。
    })();
  }, [core, interactionBusy, keyDraft, settings, smartArrange]);

  const requestClearApiKey = useCallback(() => {
    if (interactionBusy) return;
    setConfirm({
      title: settingsTexts.apiKeyClearConfirmTitle,
      message: settingsTexts.apiKeyClearConfirmMessage,
      confirmLabel: settingsTexts.clear,
      danger: true,
      onConfirm: async () => {
        if (interactionBusy) return;
        const provider = settings?.aiProvider;
        if (!provider) return;
        const result = await core.clearApiKey(provider);
        if (result.ok) {
          setKeyDraft("");
          setConfirm(null);
          core.setMessage({ tone: "success", text: settingsTexts.apiKeyCleared });
        }
      },
    });
  }, [core, interactionBusy, settings]);

  const browseDirectory = useCallback(
    async (kind: DirectoryKind) => {
      if (interactionBusy) return;
      const result = await core.chooseDirectory(kind);
      if (!result.ok) return; // 失败已显示
      if (result.value === null) return; // 取消选择：不进入预览，也不执行
      setDirectoryPreview(result.value);
    },
    [core, interactionBusy],
  );

  const confirmDirectoryChange = useCallback(
    async (token: string) => {
      if (interactionBusy) return;
      const result = await core.applyDirectoryChange(token);
      if (result.ok) setDirectoryPreview(null);
      // 失败保留预览；错误已显示。
    },
    [core, interactionBusy],
  );

  const chooseImport = useCallback(async () => {
    if (interactionBusy) return;
    const result = await core.chooseBackupImport();
    if (!result.ok) return;
    if (result.value === null) return; // 取消选择：不做事
    setImportPreview(result.value);
  }, [core, interactionBusy]);

  const confirmImport = useCallback(
    async (token: string) => {
      if (interactionBusy) return;
      const result = await core.importBackup(token);
      if (result.ok) setImportPreview(null);
    },
    [core, interactionBusy],
  );

  const exportBackup = useCallback(() => {
    if (interactionBusy) return;
    void core.exportBackup();
  }, [core, interactionBusy]);

  const exportMarkdown = useCallback(() => {
    if (interactionBusy) return;
    void core.exportMarkdown();
  }, [core, interactionBusy]);

  const hasUnsavedInput = Boolean(
    settings &&
      hasUnsavedSettingsInput({
        reminderTimeInput,
        reminderTimeError,
        savedReminderTime: settings.dailyReminderTime,
        dailyReminderEnabled: settings.dailyReminderEnabled,
        apiKeyDraft: keyDraft,
        quickDueEditorOpen: quickDueEditor !== null,
        customerRenaming: renamingCustomer !== null,
      }),
  );

  const handleBack = useCallback(() => {
    if (interactionBusy) return; // 任一设置来源写入时不误退，避免响应竞态。
    if (hasUnsavedInput) {
      core.clearMessage(); // 不能让"已保存"与放弃确认同时出现
      setConfirm({
        title: "放弃未保存的更改？",
        message: "页面中有未提交或未保存的输入，返回后将丢失。",
        confirmLabel: "放弃并返回",
        danger: true,
        onConfirm: async () => {
          setConfirm(null);
          onBack();
        },
      });
      return;
    }
    onBack();
  }, [core, hasUnsavedInput, interactionBusy, onBack]);

  // Escape 先取消当前弹层/编辑，普通设置页复用返回按钮的未保存输入保护。
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (interactionBusy) return;
      if (importPreview || directoryPreview) {
        setImportPreview(null);
        setDirectoryPreview(null);
        return;
      }
      if (confirm) {
        setConfirm(null);
        return;
      }
      if (quickDueEditor) {
        setQuickDueEditor(null);
        return;
      }
      if (renamingCustomer) {
        setRenamingCustomer(null);
        return;
      }
      handleBack();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, confirm, directoryPreview, handleBack, importPreview, interactionBusy, quickDueEditor, renamingCustomer]);

  if (state.phase === "loading") {
    return (
      <div className="pometodo-settings" role="status">
        <span className="settings-loading">{settingsTexts.loading}</span>
      </div>
    );
  }

  if (state.phase === "loadError" || !snapshot || !settings) {
    return (
      <div className="pometodo-settings" role="alert">
        <span className="settings-loading">{state.loadError ?? settingsTexts.loadFailed}</span>
        <button className="settings-button primary" type="button" onClick={() => void core.load()}>
          {settingsTexts.retry}
        </button>
      </div>
    );
  }

  return (
    <div className="pometodo-settings" aria-busy={interactionBusy}>
      <header className="settings-topbar">
        <div className="settings-topbar-text">
          <h1 className="settings-title">{settingsTexts.title}</h1>
          <span className="settings-subtitle">{settingsTexts.subtitle}</span>
        </div>
        <button className="settings-button settings-back" type="button" disabled={interactionBusy} onClick={handleBack}>
          <span className="page-action-label">{settingsTexts.back}</span>
        </button>
      </header>
      <div className="settings-scroll">

      <div className="settings-groups">

      {/* 账户卡自带与设置分组一致的折叠标题栏与摘要行，不再包一层普通分组。 */}
      {accountCard}
      <SettingsGroup title={settingsTexts.sceneGroup}
        headerControl={
          <SceneSegment
            label={settingsTexts.sceneGroup}
            choices={sceneChoices}
            value={sceneValue(settings?.customerLabel)}
            disabled={interactionBusy}
            onChange={(scene) => void commitScene(scene)}
          />
        }
      />
      <SettingsGroup title={settingsTexts.generalGroup} collapsible open={groupOpen("general", true)} onOpenChange={(open) => setGroupOpen("general", open)}>
          <SettingsRow
            title={settingsTexts.startWithWindowsTitle}
            hint={settingsTexts.startWithWindowsHint}
            control={
              <ToggleSwitch
                label={settingsTexts.startWithWindowsTitle}
                checked={settings.startWithWindows}
                disabled={interactionBusy}
                onToggle={(next) => void applyUpdate({ startWithWindows: next })}
              />
            }
          />
          <SettingsRow
            title={settingsTexts.startMinimizedTitle}
            hint={settingsTexts.startMinimizedHint}
            control={
              <ToggleSwitch
                label={settingsTexts.startMinimizedTitle}
                checked={settings.startMinimized}
                disabled={interactionBusy}
                onToggle={(next) => void applyUpdate({ startMinimized: next })}
              />
            }
          />
          <SettingsRow
            title={settingsTexts.autoBackupTitle}
            hint={settingsTexts.autoBackupHint}
            control={
              <ToggleSwitch
                label={settingsTexts.autoBackupTitle}
                checked={Boolean(settings.autoBackupEnabled)}
                disabled={interactionBusy}
                onToggle={(next) => void applyUpdate({ autoBackupEnabled: next })}
              />
            }
          />
          <SettingsRow title={settingsTexts.windowLevelTitle} stacked>
            <div className="settings-radio-group" role="radiogroup" aria-label={settingsTexts.windowLevelTitle}>
              {([
                { value: "normal", label: settingsTexts.windowLevelNormal },
                { value: "topmost", label: settingsTexts.windowLevelTopmost },
              ] as const).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={(settings.windowLevel ?? "normal") === item.value}
                  disabled={interactionBusy}
                  className={`settings-radio-option${(settings.windowLevel ?? "normal") === item.value ? " selected" : ""}`}
                  onClick={() => void applyUpdate({ windowLevel: item.value })}
                >
                  <span className="settings-radio-dot" aria-hidden="true" />
                  <span className="settings-radio-copy">
                    <span className="settings-radio-title">{item.label}</span>
                    <span className="settings-row-hint">{settingsTexts.windowLevelHint}</span>
                  </span>
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow title={settingsTexts.panelOpacityTitle} hint={settingsTexts.panelOpacityHint}
            control={
              <input
                className="settings-opacity-range"
                type="range"
                min={50}
                max={100}
                step={5}
                disabled={interactionBusy}
                value={settings.panelOpacity ?? 100}
                onChange={(event) => void applyUpdate({ panelOpacity: Number(event.target.value) })}
                aria-label={settingsTexts.panelOpacityTitle}
              />
            }
          />
          <SettingsRow
            title={settingsTexts.floatingBallTitle}
            hint={settingsTexts.floatingBallHint}
            control={
              <ToggleSwitch
                label={settingsTexts.floatingBallTitle}
                checked={floatingBallEnabled ?? settings.floatingBallEnabled}
                disabled={interactionBusy}
                onToggle={(next) => void applyUpdate({ floatingBallEnabled: next })}
              />
            }
          />
          <SettingsRow title={settingsTexts.closeActionGroup} stacked>
            <div className="settings-radio-group" role="radiogroup" aria-label={settingsTexts.closeActionGroup}>
              {closeActionOptions.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={settings.closeAction === item.value}
                  disabled={interactionBusy}
                  className={`settings-radio-option${settings.closeAction === item.value ? " selected" : ""}`}
                  onClick={() => void applyUpdate({ closeAction: item.value })}
                >
                  <span className="settings-radio-dot" aria-hidden="true" />
                  <span className="settings-radio-copy">
                    <span className="settings-radio-title">{item.label}</span>
                    <span className="settings-row-hint">{item.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title={settingsTexts.reminderGroup} collapsible open={groupOpen("reminder", false)} onOpenChange={(open) => setGroupOpen("reminder", open)}>
          <ReminderSettings
            enabled={settings.dailyReminderEnabled}
            timeInput={reminderTimeInput}
            error={reminderTimeError}
            busy={interactionBusy}
            dueWord={pack.dueWord}
            onEnabledChange={(next) => void applyUpdate({ dailyReminderEnabled: next })}
            onTimeInputChange={(value) => {
              setReminderTimeInput(value);
              setReminderTimeError(null);
            }}
            onCommit={() => void commitReminderTime()}
          />
        </SettingsGroup>

        <SettingsGroup title={settingsTexts.quickDueGroupNeutral} collapsible groupRef={quickDueRef} open={groupOpen("quickDue", false)} onOpenChange={(open) => setGroupOpen("quickDue", open)}>
          <QuickDueSection
            options={settings.quickDueOptions}
            busy={interactionBusy}
            editor={quickDueEditor}
            dueWord={pack.dueWord}
            onEditorChange={(editor) => { if (!interactionBusy) setQuickDueEditor(editor); }}
            onCommit={quickDueCommit}
            onRemove={quickDueRemove}
          />
        </SettingsGroup>

        {pack.key === "work" && snapshot.customers.length > 0 && (
          <SettingsGroup title={settingsTexts.customerGroup} collapsible open={groupOpen("customer", false)} onOpenChange={(open) => setGroupOpen("customer", open)}>
            <CustomerSection
              customers={snapshot.customers}
              busy={interactionBusy}
              renamingOriginal={renamingCustomer}
              onRenamingChange={(original) => { if (!interactionBusy) setRenamingCustomer(original); }}
              onRename={renameCustomer}
              onRequestRemove={requestRemoveCustomer}
            />
          </SettingsGroup>
        )}

        <SettingsGroup title={settingsTexts.smartArrangeGroup} collapsible open={groupOpen("smartArrange", true)} onOpenChange={(open) => setGroupOpen("smartArrange", open)} highlight={smartArrangeFocusActive} groupRef={smartArrangeRef}>
          <SmartArrangeSection officialServicesEnabled={smartArrange?.officialServicesEnabled} snapshot={smartArrange?.snapshot ?? null} busy={interactionBusy} onChange={(preferences) => smartArrange?.onChange(preferences)}>
            <AiKeySection
              provider={settings.aiProvider}
              keyConfigured={snapshot.keyConfigured}
              busy={interactionBusy}
              draft={keyDraft}
              onDraftChange={(value) => { if (!interactionBusy) setKeyDraft(value); }}
              onProviderChange={handleProviderChange}
              onSaveKey={saveApiKey}
              onRequestClearKey={requestClearApiKey}
            />
          </SmartArrangeSection>
        </SettingsGroup>

        {sync && (
          <SettingsGroup title="团队同步" collapsible open={groupOpen("sync", false)} onOpenChange={(open) => setGroupOpen("sync", open)}>
            <SyncSection
              services={sync.services}
              busy={interactionBusy}
              notify={(message) => core.setMessage(message)}
              onSnapshot={sync.onSnapshot}
            />
          </SettingsGroup>
        )}

        <SettingsGroup title={settingsTexts.dataBackupGroup} collapsible open={groupOpen("dataBackup", false)} onOpenChange={(open) => setGroupOpen("dataBackup", open)}>
          <DirectorySection
            dataDirectory={snapshot.dataDirectory}
            screenshotDirectory={snapshot.screenshotDirectory}
            busy={interactionBusy}
            preview={directoryPreview}
            onPreviewChange={setDirectoryPreview}
            onBrowse={(kind) => void browseDirectory(kind)}
            onConfirmApply={(token) => void confirmDirectoryChange(token)}
          />
          <BackupSection
            busy={interactionBusy}
            importPreview={importPreview}
            onImportPreviewChange={setImportPreview}
            onExport={exportBackup}
            onExportMarkdown={exportMarkdown}
            onChooseImport={() => void chooseImport()}
            onConfirmImport={(token) => void confirmImport(token)}
          />
        </SettingsGroup>
      </div>

      </div>
      <StatusBar hint={hint ?? "Esc 返回列表"} message={systemMessage ?? state.actionMessage}
        onDismiss={() => { if (systemMessage) onDismissSystemMessage?.(); else core.clearMessage(); }}>
        <button className="pome-statusbar-version" type="button" title="检查更新" disabled={!onCheckUpdate || updateChecking} onClick={onCheckUpdate}>51CodeTodo {snapshot.version}</button>
      </StatusBar>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          busy={interactionBusy}
          onConfirm={() => void confirm.onConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
