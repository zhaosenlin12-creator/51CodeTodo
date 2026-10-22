/** 设置页面与原生服务的数据接口；页面不直接调用系统或保存凭据。 */
export type SettingsTheme = "system" | "light" | "dark";
export type AiProvider = "minimax" | "deepseek" | "qwen" | "glm";
export type DirectoryKind = "data" | "screenshots";
export interface QuickDueSetting { label: string; days: number }
export interface CustomerSetting { originalName: string; displayName: string; activeCount: number }

export type WindowLevel = "normal" | "topmost";
export type BallOpenOn = "hover" | "click";
export type TodoTabId = "today" | "pending" | "in_progress" | "completed";

export interface AppSettings {
  theme: SettingsTheme;
  startWithWindows: boolean;
  startMinimized: boolean;
  floatingBallEnabled: boolean;
  closeAction: "tray" | "exit";
  dailyReminderEnabled: boolean;
  dailyReminderTime: string;
  quickDueOptions: QuickDueSetting[];
  aiProvider: AiProvider;
  /** “客户”字段的显示名（默认“客户”），仅影响界面文案。 */
  customerLabel: string;
  // ---- 0.2.6 扩展（先由后端保存校验，界面逐步接入）----
  /** 面板透明度 50–100。 */
  panelOpacity?: number;
  windowLevel?: WindowLevel;
  pinnedToDesktop?: boolean;
  taskReminderEnabled?: boolean;
  /** 稍后提醒间隔：5/10/15/30/60 分钟。 */
  reminderSnoozeMinutes?: number;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  todoTabOrder?: TodoTabId[];
  todoTabLabels?: Partial<Record<TodoTabId, string>>;
  todoTabHidden?: TodoTabId[];
  floatingBallSkin?: string;
  floatingBallEdgeHide?: boolean;
  floatingBallOpenOn?: BallOpenOn;
  floatingBallTalk?: boolean;
  floatingBallDrop?: boolean;
  floatingBallDoubleClick?: boolean;
  autoBackupEnabled?: boolean;
  lastAutoBackupAt?: string | null;
  /** 云端同步占位，阶段二实现。 */
  syncEnabled?: boolean;
}
export interface SettingsSnapshot {
  settings: AppSettings;
  customers: CustomerSetting[];
  keyConfigured: Record<AiProvider, boolean>;
  dataDirectory: string;
  screenshotDirectory: string;
  version: string;
}
/** 预检和执行分开；token 由原生宿主管理，前端不能自行构造路径或文件内容。 */
export interface DirectoryChangePreview {
  token: string;
  kind: DirectoryKind;
  source: string;
  destination: string;
  message: string;
}
export interface BackupImportPreview {
  token: string;
  fileName: string;
  taskCount: number;
  attachmentCount: number;
  message: string;
}
export interface SettingsActionResult {
  snapshot: SettingsSnapshot;
  message: string;
}
export interface SettingsServices {
  load(): Promise<SettingsSnapshot>;
  /** 只传变更字段；resolve 表示系统应用及本地保存成功，reject 保留旧值并提示。 */
  update(patch: Partial<AppSettings>): Promise<SettingsSnapshot>;
  renameCustomer(originalName: string, displayName: string): Promise<SettingsSnapshot>;
  hideCustomer(originalName: string): Promise<SettingsSnapshot>;
  saveApiKey(provider: AiProvider, key: string): Promise<SettingsSnapshot>;
  clearApiKey(provider: AiProvider): Promise<SettingsSnapshot>;
  chooseDirectory(kind: DirectoryKind): Promise<DirectoryChangePreview | null>;
  applyDirectoryChange(token: string): Promise<SettingsActionResult>;
  exportBackup(): Promise<{ message: string } | null>;
  exportMarkdown(): Promise<{ message: string } | null>;
  chooseBackupImport(): Promise<BackupImportPreview | null>;
  importBackup(token: string): Promise<SettingsActionResult>;
}
export interface SettingsPageProps {
  services: SettingsServices;
  onBack(): void;
  /** 每次已确认成功后通知宿主同步主题、标签、客户联想、数据刷新。 */
  onChanged?(snapshot: SettingsSnapshot): void;
}
