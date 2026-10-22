import type { ChangeEvent } from "react";

interface SearchInputProps {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}

/** 搜索输入框，提取自 sltool 的 SearchInput 组件。 */
export default function SearchInput({ placeholder = "Search", value, onChange }: SearchInputProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.value);
  };

  return (
    <div className="search-input-container">
      <span className="search-input-label" aria-hidden="true"><svg className="search-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></span>
      <input
        className="search-input-field"
        placeholder={placeholder}
        aria-label="搜索客户、任务、备注"
        value={value}
        onChange={handleChange}
        type="text"
      />
      {value && <button type="button" className="search-input-clear" onClick={() => onChange("")} aria-label="清空搜索">×</button>}
    </div>
  );
}
