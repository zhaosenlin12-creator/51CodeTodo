import { useEffect, useState, type ReactNode, type RefObject } from "react";
import type { TodoDisplayGroup, TodoTask } from "../todoModel";
import { todoIcons } from "./TodoIcons";

interface Props {
  recent: TodoDisplayGroup[];
  archived: TodoDisplayGroup[];
  archive: boolean;
  onArchive: () => void;
  renderTask: (task: TodoTask, index: number) => ReactNode;
  focusTaskId: string | null;
  listRef: RefObject<HTMLDivElement | null>;
}

export default function CompletedList({ recent, archived, archive, onArchive, renderTask, focusTaskId, listRef }: Props) {
  // undefined 表示尚未手动切换：默认展开今天或最近有记录的一天。
  const [expanded, setExpanded] = useState<string | null | undefined>();
  const [limit, setLimit] = useState(10);
  const openKey = expanded === undefined ? recent[0]?.key : expanded;
  const groups = archive ? archived : recent;
  useEffect(() => {
    if (!focusTaskId) return;
    const group = groups.find(item => item.tasks.some(task => task.id === focusTaskId));
    if (!group) return;
    setExpanded(group.key);
    const items = archive ? groups.flatMap(item => item.tasks) : group.tasks;
    setLimit(value => Math.max(value, items.findIndex(task => task.id === focusTaskId) + 1));
  }, [focusTaskId, archive, groups]);
  const count = (items: TodoDisplayGroup[]) => items.reduce((sum, group) => sum + group.tasks.length, 0);
  let shown = 0;
  if (!groups.length) {
    return <div className="page-empty-compact">
      <div className="empty-icon-compact">{todoIcons.todo}</div>
      <span>{"暂无"}</span>
    </div>;
  }
  return <div className="todo-list todo-completed-list" ref={listRef}>
    {/* 空列表不显示汇总行，避免"最近 7 天完成 0"的无效信息；仍有归档记录时保留入口。 */}
    {!archive && (recent.length > 0 || archived.length > 0) && <h2 className="todo-group-title todo-completed-summary tone-completed">
      <b aria-hidden="true" />最近 7 天完成<span>{count(recent)}</span><i aria-hidden="true" />
      <button className="todo-completed-archive" type="button" onClick={onArchive} disabled={!archived.length}>归档 <span>{count(archived)}</span></button>
    </h2>}
    {!groups.length && <div className="page-empty-compact">
      <div className="empty-icon-compact">{todoIcons.todo}</div>
      <span>{"暂无"}</span>
    </div>}
    {groups.map(group => {
      const open = archive || group.key === openKey;
      const items = archive ? group.tasks.slice(0, Math.max(0, limit - shown)) : group.tasks.slice(0, limit);
      shown += archive ? items.length : 0;
      if (archive && !items.length) return null;
      return <section className={`todo-completed-group${open ? " open" : ""}`} key={group.key}>
        {archive ? <h2 className="todo-group-title">{group.label}<span>{group.tasks.length}</span><i /></h2> :
          <button className="todo-completed-toggle" type="button" aria-expanded={open} onClick={() => { setExpanded(open ? null : group.key); setLimit(10); }}>
            <span className="todo-completed-chevron" aria-hidden="true">›</span>
            <span>{group.label}</span><span className="todo-completed-count">完成{group.tasks.length}项</span>
          </button>}
        <div className="todo-completed-collapse" inert={!open}>
          <div className="todo-completed-inner"><div className="todo-completed-cards">
            {items.map(renderTask)}
            {!archive && group.tasks.length > limit && <button className="clipboard-load-more" type="button" onClick={() => setLimit(value => value + 10)}>加载更多</button>}
          </div></div>
        </div>
      </section>;
    })}
    {archive && count(archived) > limit && <button className="clipboard-load-more" type="button" onClick={() => setLimit(value => value + 10)}>加载更多</button>}
  </div>;
}
