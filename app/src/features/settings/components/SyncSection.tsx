import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncConfigSnapshot, SyncServices } from "../../../contracts/sync";
import SettingsRow from "./SettingsRow";
import ToggleSwitch from "./ToggleSwitch";

interface SyncSectionProps {
  services: SyncServices;
  /** 设置页全局忙碌：期间禁止并发操作。 */
  busy: boolean;
  /** 复用设置页消息通道：成功/失败统一进状态栏。 */
  notify(message: { tone: "success" | "error"; text: string }): void;
  /** 配置快照变化后回传宿主，刷新看板成员与身份。 */
  onSnapshot(snapshot: SyncConfigSnapshot): void;
}

/** 校验服务器地址：默认要求 https；仅本机回环允许 http，便于本地联调。 */
function validateServerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "请填写团队服务器地址";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "服务器地址格式不正确";
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !loopback) return "团队服务器地址需使用 https";
  return null;
}

export default function SyncSection({ services, busy, notify, onSnapshot }: SyncSectionProps) {
  const [snapshot, setSnapshot] = useState<SyncConfigSnapshot | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const applySnapshot = useCallback((next: SyncConfigSnapshot) => {
    setSnapshot(next);
    onSnapshot(next);
  }, [onSnapshot]);

  // notify 由页面内联传入，引用会变；用 ref 保持首次加载 effect 只跑一次。
  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);

  useEffect(() => {
    let cancelled = false;
    void services.configGet().then((result) => {
      if (cancelled) return;
      setSnapshot(result);
      setUrlDraft(result.serverUrl ?? "");
      setNicknameDraft(result.nickname ?? "");
    }).catch((error: unknown) => {
      if (cancelled) return;
      notifyRef.current({ tone: "error", text: error instanceof Error ? error.message : "读取同步配置失败" });
    });
    return () => { cancelled = true; };
  }, [services]);

  const running = busy || localBusy;

  const commitConfig = useCallback(async (): Promise<boolean> => {
    if (running) return false;
    const urlError = validateServerUrl(urlDraft);
    if (urlError) { setFieldError(urlError); return false; }
    const nickname = nicknameDraft.trim();
    if (!nickname) { setFieldError("请填写团队昵称"); return false; }
    setFieldError(null);
    setLocalBusy(true);
    try {
      const patch: { serverUrl?: string; nickname?: string; accessToken?: string } = {
        serverUrl: urlDraft.trim(),
        nickname,
      };
      if (tokenDraft.trim()) patch.accessToken = tokenDraft.trim();
      const next = await services.configUpdate(patch);
      applySnapshot(next);
      setTokenDraft("");
      notify({ tone: "success", text: "同步配置已保存" });
      return true;
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "保存同步配置失败" });
      return false;
    } finally {
      setLocalBusy(false);
    }
  }, [running, urlDraft, nicknameDraft, tokenDraft, services, applySnapshot, notify]);

  const toggleEnabled = useCallback(async (next: boolean) => {
    if (running) return;
    setLocalBusy(true);
    try {
      const result = await services.configUpdate({ enabled: next });
      applySnapshot(result);
      notify({ tone: "success", text: next ? "已开启团队同步" : "已关闭团队同步" });
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "更新同步开关失败" });
    } finally {
      setLocalBusy(false);
    }
  }, [running, services, applySnapshot, notify]);

  const joinTeam = useCallback(async () => {
    if (running) return;
    const urlError = validateServerUrl(urlDraft);
    if (urlError) { setFieldError(urlError); return; }
    if (!nicknameDraft.trim()) { setFieldError("请先填写团队昵称"); return; }
    setFieldError(null);
    // 先保存地址/昵称/令牌，再用已保存的凭证加入；保存失败则不继续。
    const saved = await commitConfig();
    if (!saved) return;
    setLocalBusy(true);
    try {
      const member = await services.join();
      const next = await services.configGet();
      applySnapshot(next);
      notify({ tone: "success", text: `已加入团队，昵称「${member.nickname}」` });
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "加入团队失败" });
    } finally {
      setLocalBusy(false);
    }
  }, [running, urlDraft, nicknameDraft, services, commitConfig, applySnapshot, notify]);

  const syncNow = useCallback(async () => {
    if (running) return;
    if (!snapshot?.memberId) {
      notify({ tone: "error", text: "尚未加入团队，请先填写昵称并点击加入" });
      return;
    }
    setLocalBusy(true);
    try {
      const summary = await services.syncNow();
      const next = await services.configGet();
      applySnapshot(next);
      notify({ tone: "success", text: `已推送 ${summary.pushed} 条，拉取 ${summary.pulled} 条，当前 rev ${summary.rev}` });
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "立即同步失败" });
    } finally {
      setLocalBusy(false);
    }
  }, [running, snapshot?.memberId, services, applySnapshot, notify]);

  const refreshMembers = useCallback(async () => {
    if (running) return;
    if (!snapshot?.memberId) {
      notify({ tone: "error", text: "尚未加入团队，无法刷新成员" });
      return;
    }
    setLocalBusy(true);
    try {
      await services.members();
      const next = await services.configGet();
      applySnapshot(next);
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "刷新成员失败" });
    } finally {
      setLocalBusy(false);
    }
  }, [running, snapshot?.memberId, services, applySnapshot, notify]);

  const joined = Boolean(snapshot?.memberId);

  return (
    <div className="settings-stack">
      <SettingsRow
        title="启用同步"
        hint="开启后后台按周期自动推送本地改动并拉取团队更新"
        control={
          <ToggleSwitch
            label="启用同步"
            checked={Boolean(snapshot?.enabled)}
            disabled={running}
            onToggle={(next) => void toggleEnabled(next)}
          />
        }
      />
      <SettingsRow title="服务器地址" stacked>
        <div className="settings-input-row">
          <input
            className={`settings-input${fieldError ? " error" : ""}`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://团队服务器地址"
            aria-label="团队服务器地址"
            value={urlDraft}
            disabled={running}
            onChange={(event) => { setUrlDraft(event.target.value); setFieldError(null); }}
          />
        </div>
      </SettingsRow>
      <SettingsRow title="访问令牌" stacked>
        <div className="settings-input-row">
          <input
            className="settings-input settings-input-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={snapshot?.hasToken ? "令牌已保存，留空保持不变" : "粘贴团队访问令牌"}
            aria-label="访问令牌"
            value={tokenDraft}
            disabled={running}
            onChange={(event) => setTokenDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitConfig(); } }}
          />
          <button className="settings-button primary" type="button" disabled={running} onClick={() => void commitConfig()}>
            保存
          </button>
        </div>
      </SettingsRow>
      <SettingsRow title="团队昵称" stacked>
        <div className="settings-input-row">
          <input
            className="settings-input"
            type="text"
            maxLength={24}
            autoComplete="off"
            placeholder="加入团队时展示的昵称（最长 24 字）"
            aria-label="团队昵称"
            value={nicknameDraft}
            disabled={running}
            onChange={(event) => { setNicknameDraft(event.target.value); setFieldError(null); }}
          />
        </div>
      </SettingsRow>
      {fieldError && <span className="settings-field-error">{fieldError}</span>}
      <div className="settings-button-row">
        <button className="settings-button primary" type="button" disabled={running} onClick={() => void joinTeam()}>
          加入团队
        </button>
        <button className="settings-button" type="button" disabled={running} onClick={() => void syncNow()}>
          立即同步
        </button>
        <button className="settings-button" type="button" disabled={running} onClick={() => void refreshMembers()}>
          刷新成员
        </button>
      </div>
      <div className="settings-preview-list">
        <p className="settings-preview-row">
          <span className="settings-preview-label">身份</span>
          <span>{joined ? `${snapshot?.nickname ?? ""}（${snapshot?.memberId}）` : "尚未加入团队"}</span>
        </p>
        <p className="settings-preview-row">
          <span className="settings-preview-label">状态</span>
          <span>{snapshot?.enabled ? "已开启自动同步" : "未开启自动同步"} · 当前 rev {snapshot?.lastRev ?? 0}</span>
        </p>
        <p className="settings-preview-row">
          <span className="settings-preview-label">成员</span>
          <span>{snapshot && snapshot.members.length > 0
            ? snapshot.members.map((member) => member.nickname || member.memberId).join("、")
            : "暂无成员"}（共 {snapshot?.members.length ?? 0} 人）</span>
        </p>
      </div>
    </div>
  );
}
