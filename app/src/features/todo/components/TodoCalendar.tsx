/** 弹层内使用的本地日历，提取自原待办页面的日期选择实现。 */

const calendarWeekdays = ["一", "二", "三", "四", "五", "六", "日"];

export function shiftCalendarMonth(date: Date, offset: number) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

export function formatCalendarMonth(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function isSameCalendarDate(left: Date | null, right: Date) {
  if (!left) return false;
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function toDateInputValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function buildCalendarDays(monthDate: Date) {
  const firstOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
  const firstCell = new Date(firstOfMonth);
  firstCell.setDate(firstOfMonth.getDate() - mondayOffset);
  const today = new Date();

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstCell);
    date.setDate(firstCell.getDate() + index);
    return {
      date,
      value: toDateInputValue(date),
      label: `${date.getDate()}`,
      inMonth: date.getMonth() === monthDate.getMonth(),
      isToday: isSameCalendarDate(today, date),
    };
  });
}

interface TodoCalendarProps {
  month: Date;
  onShiftMonth: (offset: number) => void;
  selectedDate: Date | null;
  onSelect: (value: string) => void;
  onClear?: () => void;
  /** 清空按钮文字（随场景词包变化，如“不设交付日期/不设完成日期”）。 */
  clearLabel?: string;
  className?: string;
}

export default function TodoCalendar({
  month,
  onShiftMonth,
  selectedDate,
  onSelect,
  onClear,
  clearLabel = "不设交付日期",
  className = "",
}: TodoCalendarProps) {
  const days = buildCalendarDays(month);

  return (
    <div className={`todo-dialog-calendar${className ? ` ${className}` : ""}`}>
      <div className="todo-dialog-calendar-head">
        <button type="button" onClick={() => onShiftMonth(-1)}>
          ‹
        </button>
        <span>{formatCalendarMonth(month)}</span>
        <button type="button" onClick={() => onShiftMonth(1)}>
          ›
        </button>
      </div>
      <div className="todo-dialog-calendar-weekdays">
        {calendarWeekdays.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="todo-dialog-calendar-grid">
        {days.map((day) => (
          <button
            key={day.value}
            className={`todo-dialog-calendar-day${day.inMonth ? "" : " muted"}${day.isToday ? " today" : ""}${isSameCalendarDate(selectedDate, day.date) ? " selected" : ""}`}
            type="button"
            onClick={() => onSelect(day.value)}
          >
            {day.label}
          </button>
        ))}
      </div>
      {onClear && <button type="button" className="todo-calendar-clear" onClick={onClear}>{clearLabel}</button>}
    </div>
  );
}
