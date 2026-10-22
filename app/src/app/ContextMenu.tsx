import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./contextMenu.css";

interface MenuSnapshot { id: number; floating: boolean; mainVisible: boolean; floatingEnabled: boolean; theme: string }
export function ContextMenu() {
  const [menu, setMenu] = useState<MenuSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const receive = (value: MenuSnapshot | null) => { if (active) { setMenu(current => value && current && value.id < current.id ? current : value); setError(null); } };
    const subscription = listen<MenuSnapshot>("pometodo-menu-open", event => receive(event.payload));
    void subscription.then(() => invoke<MenuSnapshot | null>("pometodo_menu_snapshot")).then(receive).catch(() => setError("菜单暂不可用"));
    return () => { active = false; void subscription.then(fn => fn()); };
  }, []);
  useLayoutEffect(() => {
    if (!menu) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = menu.theme === "system" ? (media.matches ? "dark" : "light") : menu.theme; };
    apply();
    media.addEventListener("change", apply);
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      void invoke("pometodo_menu_present", { id: menu.id }).then(() => panel.current?.focus()).catch(() => setError("菜单未能显示"));
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); media.removeEventListener("change", apply); };
  }, [menu]);
  async function act(action: string) {
    if (!menu) return;
    try { await invoke("pometodo_menu_action", { id: menu.id, action }); }
    catch { setError("操作未完成，请重试"); }
  }
  if (!menu) return null;
  return <div className="pome-context-host" onMouseDown={event => { if (event.target === event.currentTarget) void act("dismiss"); }}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); void act("dismiss"); }
      const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) {
        event.preventDefault();
        const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : current < 0 ? (event.key === "ArrowUp" ? items.length - 1 : 0)
          : (current + ((event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) ? -1 : 1) + items.length) % items.length;
        items[index]?.focus();
      }
    }}>
    <div ref={panel} tabIndex={-1} className="pome-context-panel" role="menu" aria-label={menu.floating ? "浮球菜单" : "托盘菜单"}>
      {!menu.floating && <button role="menuitem" onClick={() => void act("main")}>{menu.mainVisible ? "隐藏到托盘" : "打开 51CodeTodo"}</button>}
      <button role="menuitem" onClick={() => void act("floating")}>{menu.floating || menu.floatingEnabled ? "隐藏浮球" : "显示浮球"}</button>
      <div role="separator" />
      <button role="menuitem" onClick={() => void act("settings")}>设置...</button>
      {!menu.floating && <><div role="separator" /><button role="menuitem" onClick={() => void act("quit")}>退出应用</button></>}
      {error && <p role="alert">{error}</p>}
    </div>
  </div>;
}
