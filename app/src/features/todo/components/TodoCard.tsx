import type { CSSProperties, MouseEvent } from "react";
import type { TodoTask } from "../../../contracts/todo";
import type { SyncMember } from "../../../contracts/sync";
import type { TodoDueInfo, TodoWorkflowAction } from "../todoModel";
import { buildAssigneeOptions } from "../syncModel";
import {
  dueWordsFor,
  formatTodoReceivedLabel,
  getTodoWorkflowActions,
  shouldShowTodoNote,
} from "../todoModel";
import { todoTexts } from "../todoTexts";
import { wordPackFor, type TodoWordPack } from "../wordPacks";
import { todoIcons } from "./TodoIcons";

function stopCardAction(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function workflowActionIcon(action: TodoWorkflowAction) {
  if (action === "defer") return todoIcons.delay;
  if (action === "start" || action === "resume") return todoIcons.play;
  if (action === "wait") return todoIcons.pause;
  if (action === "rollback" || action === "restore") return todoIcons.undo;
  return todoIcons.check;
}

function workflowActionLabel(action: TodoWorkflowAction) {
  if (action === "defer") return todoTexts.defer;
  if (action === "start") return todoTexts.start;
  if (action === "wait") return todoTexts.wait;
  if (action === "resume") return todoTexts.resume;
  if (action === "rollback") return todoTexts.rollback;
  if (action === "restore") return todoTexts.restore;
  return todoTexts.complete;
}

interface TodoCardProps {
  task: TodoTask;
  enterIndex: number;
  dueInfo: TodoDueInfo | null;
  todayContext?: boolean;
  archived?: boolean;
  highlighted: boolean;
  busy: boolean;
  wordPack?: TodoWordPack;
  onOpenEdit: (task: TodoTask) => void;
  onSetUrgent: (task: TodoTask, urgent: boolean) => void;
  onOpenDeferPicker: (task: TodoTask) => void;
  onWorkflowAction: (task: TodoTask, action: TodoWorkflowAction) => void;
  onOpenAttachment: (path: string) => void;
  onArchive?: (task: TodoTask) => void;
  onUnarchive?: (task: TodoTask) => void;
  /** 团队成员选项；缺省或为空时不渲染指派入口。 */
  members?: SyncMember[];
  /** 未加入团队时禁用指派并给提示。 */
  assigneeDisabled?: boolean;
  onSetAssignee?: (task: TodoTask, assignee: string | null) => void;
}

export default function TodoCard({
  task,
  enterIndex,
  dueInfo,
  todayContext,
  archived = false,
  highlighted,
  busy,
  wordPack = wordPackFor(undefined),
  onOpenEdit,
  onSetUrgent,
  onOpenDeferPicker,
  onWorkflowAction,
  onOpenAttachment,
  onArchive,
  onUnarchive,
  members,
  assigneeDisabled = false,
  onSetAssignee,
}: TodoCardProps) {
  const hasAttachments = task.attachmentPaths.length > 0;
  const workflowActions = archived ? [] : getTodoWorkflowActions(task);
  const dueWords = dueWordsFor(wordPack.dueWord);
  const todayLabel = todayContext && task.dueAt ? dueInfo?.tone === "overdue" ? "逾期" : task.status === "in_progress" ? "进行中" : task.status === "waiting" ? "搁置" : dueInfo?.label === dueWords.today ? dueWords.expiringToday : null : task.status === "waiting" ? "搁置" : null;
  const sourceName = task.customerName || wordPack.noCustomer;

  return (
    <article
      className={`notification todo-card status-${task.status}${task.urgentAt ? " urgent" : ""}${dueInfo ? ` tone-${dueInfo.tone}` : ""}${highlighted ? " floating-highlight" : ""}${busy ? " busy" : ""}`}
      data-task-id={task.id}
      style={{ "--enter-delay": enterIndex } as CSSProperties}
      onClick={() => onOpenEdit(task)}
    >
      <div className="notibar" />
      <div className="noticontent">
        <div className="notititle todo-card-header">
          <div className="todo-card-source">
            {sourceName && <span className="todo-card-person">{sourceName}</span>}
            <span className="todo-card-received">{sourceName ? "· " : ""}{formatTodoReceivedLabel(task.receivedAt)}</span>
          </div>
          {task.category?.trim() && <span className="todo-card-category">{task.category.trim()}</span>}
          {todayLabel && <span className={`todo-card-status-pill ${todayLabel === "逾期" ? "overdue" : todayLabel === "进行中" ? "upcoming" : "today"}`}><span className="todo-control-label">{todayLabel}</span></span>}
          {task.urgentAt && (
            <button
              className="todo-card-urgent-badge"
              type="button"
              disabled={busy}
              onClick={(event) => {
                stopCardAction(event);
                onSetUrgent(task, false);
              }}
              title={todoTexts.unmarkUrgent}
              aria-label={todoTexts.unmarkUrgent}
            >
              <span className="todo-control-label">{todoTexts.urgent}</span>
            </button>
          )}
        </div>
        <div className="notibody todo-card-body">
          <div className="todo-card-title">{task.title}</div>
          {shouldShowTodoNote(task) && <div className="todo-card-note">{task.note}</div>}
        </div>
        <div className="notititle todo-card-footer">
          <div className="todo-card-meta">
            {dueInfo && (
            <button
              className={`todo-card-due-badge${task.status === "completed" ? " readonly" : ""}`}
              type="button"
              disabled={busy}
              onClick={(event) => {
                stopCardAction(event);
                if (task.status !== "completed") onOpenDeferPicker(task);
              }}
              title={task.status === "completed" ? dueInfo.label : todoTexts.defer}
              aria-label={task.status === "completed" ? dueInfo.label : todoTexts.defer}
            >
              {todoIcons.calendar}<span className="todo-control-label">{dueInfo.label}</span>
            </button>
          )}
            {hasAttachments && (
              <button
                className="todo-card-attachment-badge"
                type="button"
                onClick={(event) => { stopCardAction(event); onOpenAttachment(task.attachmentPaths[0]); }}
                title={todoTexts.viewScreenshots}
                aria-label={`查看 ${task.attachmentPaths.length} 张截图`}
              >
                {todoIcons.image}<span className="todo-control-label">查看 {task.attachmentPaths.length} 张截图</span>
              </button>
            )}
            {members && members.length > 0 && (
              <select
                className="todo-card-assignee"
                value={task.assignee ?? ""}
                disabled={busy || assigneeDisabled}
                title={assigneeDisabled ? "尚未加入团队，无法指派" : "指派成员"}
                aria-label="指派成员"
                onClick={stopCardAction}
                onChange={(event) => {
                  event.stopPropagation();
                  onSetAssignee?.(task, event.target.value || null);
                }}
              >
                <option value="">清除指派</option>
                {buildAssigneeOptions(members, task.assignee).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            )}
          </div>
          <div className="todo-card-actions">
            {task.status !== "completed" && !task.urgentAt && (
              <button
                className="todo-workflow-action todo-urgent-action"
                type="button"
                disabled={busy}
                onClick={(event) => {
                  stopCardAction(event);
                  onSetUrgent(task, true);
                }}
                title={todoTexts.markUrgent}
                aria-label={todoTexts.markUrgent}
              >
                {todoIcons.urgentUp}
                <span className="todo-control-label">{todoTexts.markUrgent}</span>
              </button>
            )}
            {archived && onUnarchive && (
              <button
                className="todo-workflow-action unarchive"
                type="button"
                disabled={busy}
                onClick={(event) => {
                  stopCardAction(event);
                  onUnarchive(task);
                }}
                title="取消归档"
                aria-label="取消归档"
              >
                {todoIcons.undo}
                <span className="todo-control-label">取消归档</span>
              </button>
            )}
            {!archived && task.status === "completed" && onArchive && (
              <button
                className="todo-workflow-action archive"
                type="button"
                disabled={busy}
                onClick={(event) => {
                  stopCardAction(event);
                  onArchive(task);
                }}
                title="归档"
                aria-label="归档"
              >
                {todoIcons.folder}
                <span className="todo-control-label">归档</span>
              </button>
            )}
            {workflowActions.map((action) => (
              <button
                key={action}
                className={`todo-workflow-action ${action}`}
                type="button"
                disabled={busy}
                onClick={(event) => {
                  stopCardAction(event);
                  onWorkflowAction(task, action);
                }}
                title={workflowActionLabel(action)}
                aria-label={workflowActionLabel(action)}
              >
                {workflowActionIcon(action)}
                <span className="todo-control-label">{workflowActionLabel(action)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
