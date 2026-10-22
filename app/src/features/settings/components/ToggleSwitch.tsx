interface ToggleSwitchProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onToggle: (next: boolean) => void;
}

/** 开关控件；开关成功与否由控制器决定，组件只发出意图。 */
export default function ToggleSwitch({ checked, disabled = false, label, onToggle }: ToggleSwitchProps) {
  return (
    <button
      className={`settings-switch${checked ? " on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
    >
      <span className="settings-switch-thumb" aria-hidden="true" />
    </button>
  );
}
