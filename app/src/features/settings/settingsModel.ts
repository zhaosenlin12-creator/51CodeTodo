/**
 * 设置纯逻辑：提醒时间校验、交付日期标签校验、客户搜索与改名校验。
 * 行为来源为旧 WPF 设置页；不照搬其"非法时间静默改成 09:00"的行为，
 * 非法输入一律保留并返回可读错误，由调用方决定是否提交服务。
 */
import type { CustomerSetting, QuickDueSetting } from "../../contracts/settings";

export interface ParsedTimeInput {
  ok: true;
  normalized: string;
}
export interface InvalidTimeInput {
  ok: false;
  error: string;
}

export const QUICK_DUE_MAX_OPTIONS = 12;
export const QUICK_DUE_MAX_LABEL_LENGTH = 12;
export const CUSTOMER_MAX_DISPLAY_LENGTH = 100;

/** 校验 HH:mm 提醒时间；"9:5" 这类合法短格式规范化为 "09:05"。 */
export function parseReminderTimeInput(value: string): ParsedTimeInput | InvalidTimeInput {
  const text = value.trim();
  const match = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) {
    return { ok: false, error: "时间格式应为 HH:mm，例如 09:00。" };
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return { ok: false, error: "时间格式应为 HH:mm，例如 09:00。" };
  }
  return {
    ok: true,
    normalized: `${`${hour}`.padStart(2, "0")}:${`${minute}`.padStart(2, "0")}`,
  };
}

export type QuickDueValidation =
  | { ok: true; option: QuickDueSetting }
  | { ok: false; error: string };

/**
 * 校验添加或编辑交付日期标签。
 * 标签 trim 后 1-12 字；天数必须是 0-365 的整数；总共最多 12 项；
 * 名称与其他项忽略大小写重复时拒绝（编辑自身那一项除外）。
 */
export function validateQuickDueOption(
  rawLabel: string,
  rawDays: string,
  options: QuickDueSetting[],
  editingIndex: number | null,
): QuickDueValidation {
  const label = rawLabel.trim();
  if (!label) {
    return { ok: false, error: "请输入标签名。" };
  }
  if (label.length > QUICK_DUE_MAX_LABEL_LENGTH) {
    return { ok: false, error: `标签名不能超过 ${QUICK_DUE_MAX_LABEL_LENGTH} 个字。` };
  }

  const daysText = rawDays.trim();
  if (!/^\d+$/.test(daysText)) {
    return { ok: false, error: "请输入 0-365 的整数天数。" };
  }
  const days = Number(daysText);
  if (days > 365) {
    return { ok: false, error: "请输入 0-365 的整数天数。" };
  }

  if (editingIndex === null && options.length >= QUICK_DUE_MAX_OPTIONS) {
    return { ok: false, error: `最多添加 ${QUICK_DUE_MAX_OPTIONS} 个标签。` };
  }

  const duplicate = options.some(
    (item, index) =>
      index !== editingIndex && item.label.trim().toLowerCase() === label.toLowerCase(),
  );
  if (duplicate) {
    return { ok: false, error: "已存在同名标签。" };
  }

  return { ok: true, option: { label, days } };
}

/** 至少保留一个交付日期标签，不能全部删光。 */
export function canRemoveQuickDueOption(options: QuickDueSetting[]): boolean {
  return options.length > 1;
}

export interface QuickDueEditorTarget {
  index: number;
  /** 进入编辑时该位置的标签名；保存时确认目标未变，防止数组变化后按旧下标覆盖另一项。 */
  originalLabel: string;
}

export type QuickDueCommitPlan =
  | { kind: "save"; options: QuickDueSetting[] }
  | { kind: "stale"; error: string }
  | { kind: "invalid"; error: string };

/**
 * 生成标签编辑/添加的提交计划；调用方只在 kind=save 时写服务。
 * 编辑目标与进入编辑时不一致（被删除、移动或数组缩短）判定过期，
 * 返回可读错误且不产出保存计划，避免用旧下标覆盖另一项。
 */
export function planQuickDueCommit(
  options: QuickDueSetting[],
  rawLabel: string,
  rawDays: string,
  target: QuickDueEditorTarget | null,
): QuickDueCommitPlan {
  if (target !== null) {
    const at = options[target.index];
    if (!at || at.label !== target.originalLabel) {
      return { kind: "stale", error: "标签列表已变化，请取消后重新编辑。" };
    }
  }

  const editingIndex = target === null ? null : target.index;
  const validation = validateQuickDueOption(rawLabel, rawDays, options, editingIndex);
  if (!validation.ok) return { kind: "invalid", error: validation.error };

  const next = [...options];
  if (target === null) next.push(validation.option);
  else next[target.index] = validation.option;
  return { kind: "save", options: next };
}

export interface QuickDueEditorSnapshot {
  label: string;
  days: string;
  error: string | null;
}

export interface QuickDueEditorAfterSubmit extends QuickDueEditorSnapshot {
  closed: boolean;
}

/** 编辑表单提交结果处理：失败保留输入并显示错误，成功关闭表单。 */
export function quickDueEditorAfterSubmit(
  current: QuickDueEditorSnapshot,
  result: { ok: true } | { ok: false; message: string },
): QuickDueEditorAfterSubmit {
  if (result.ok) return { ...current, error: null, closed: true };
  return { ...current, error: result.message, closed: false };
}

/** 常用客户搜索：显示名或原始名忽略大小写包含匹配。 */
export function filterCustomers(customers: CustomerSetting[], query: string): CustomerSetting[] {
  const text = query.trim().toLowerCase();
  if (!text) return [...customers];
  return customers.filter(
    (row) =>
      row.displayName.toLowerCase().includes(text) ||
      row.originalName.toLowerCase().includes(text),
  );
}

export type CustomerRenameValidation =
  | { ok: true; displayName: string }
  | { ok: false; error: string };

/** 改名 trim 后非空、不超过 100 字。 */
export function validateCustomerDisplayName(value: string): CustomerRenameValidation {
  const displayName = value.trim();
  if (!displayName) {
    return { ok: false, error: "请输入来源显示名。" };
  }
  if (displayName.length > CUSTOMER_MAX_DISPLAY_LENGTH) {
    return { ok: false, error: `显示名不能超过 ${CUSTOMER_MAX_DISPLAY_LENGTH} 个字。` };
  }
  return { ok: true, displayName };
}

/** 仅用于显示，不改服务端用于读写文件的规范路径。 */
export function formatDirectoryPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.slice(8);
  if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
  return path;
}

export interface UnsavedInputProbe {
  /** 提醒时间输入框当前值；与已保存值不同或非法时视为未提交。 */
  reminderTimeInput: string;
  reminderTimeError: string | null;
  /** 服务中已保存的提醒时间。 */
  savedReminderTime: string;
  dailyReminderEnabled: boolean;
  /** 尚未保存的 API Key 输入。 */
  apiKeyDraft: string;
  /** 交付日期标签编辑表单是否打开。 */
  quickDueEditorOpen: boolean;
  /** 客户改名行内编辑是否进行中。 */
  customerRenaming: boolean;
}

/** 返回前判断是否存在未提交或非法输入；存在时应先询问是否放弃。 */
export function hasUnsavedSettingsInput(probe: UnsavedInputProbe): boolean {
  if (probe.customerRenaming || probe.quickDueEditorOpen) return true;
  if (probe.apiKeyDraft.trim()) return true;
  if (probe.reminderTimeError) return true;
  if (!probe.dailyReminderEnabled) return false;
  const parsed = parseReminderTimeInput(probe.reminderTimeInput);
  if (!parsed.ok) return true;
  return parsed.normalized !== probe.savedReminderTime;
}
