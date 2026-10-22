/**
 * 团队同步（M10）前端契约：与 Tauri 命令 pometodo_sync_* 的返回一一对应。
 * 字段为 camelCase，由后端 serde 直接序列化；界面不自行构造服务端 ID。
 */

/** 团队成员；memberId 是服务端签发的稳定标识，nickname 仅用于展示。 */
export interface SyncMember {
  memberId: string;
  nickname: string;
  joinedAt: string;
}

/** pometodo_sync_config_get / pometodo_sync_config_update 返回的配置快照。 */
export interface SyncConfigSnapshot {
  enabled: boolean;
  serverUrl: string | null;
  nickname: string | null;
  memberId: string | null;
  hasToken: boolean;
  lastRev: number;
  members: SyncMember[];
}

/** pometodo_sync_now 返回的一次同步结果。 */
export interface SyncSummary {
  pushed: number;
  pulled: number;
  rev: number;
  members: SyncMember[];
}

/** pometodo_sync_config_update 的增量补丁；只传需要变更的字段。 */
export interface SyncConfigPatch {
  enabled?: boolean;
  serverUrl?: string;
  accessToken?: string;
  nickname?: string;
}

/** 原生同步服务；写操作 resolve 表示已持久化，失败 reject Error，message 可供展示。 */
export interface SyncServices {
  configGet(): Promise<SyncConfigSnapshot>;
  configUpdate(patch: SyncConfigPatch): Promise<SyncConfigSnapshot>;
  /** 用已保存的昵称、地址与令牌加入团队，返回新成员。 */
  join(): Promise<SyncMember>;
  /** 立即执行一次 push + pull，返回本次结果。 */
  syncNow(): Promise<SyncSummary>;
  /** 拉取最新成员列表。 */
  members(): Promise<SyncMember[]>;
  /** 指派任务给成员；assignee 传 null 清除指派。 */
  setAssignee(id: string, assignee: string | null): Promise<void>;
}

/** 主看板消费的团队同步视角；由宿主注入，未接入时看板退回纯本地模式。 */
export interface TeamSyncBoard {
  /** 当前登录成员 ID；null 表示尚未加入团队，「我」视角不可用。 */
  memberId: string | null;
  members: SyncMember[];
  /** 指派成功返回 true；失败返回 false，错误由宿主经消息通道展示。 */
  setAssignee(taskId: string, assignee: string | null): Promise<boolean>;
}
