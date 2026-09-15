import { useSyncExternalStore } from 'react';
import { Check } from 'lucide-react';
import { getTheme, selectTheme, subscribeTheme, THEMES } from '../lib/theme.js';
import { Button, Modal } from './ui.jsx';
import './ThemeDialog.css';

export default function ThemeDialog({ onClose }) {
  const selected = useSyncExternalStore(subscribeTheme, getTheme);
  return <Modal title="外观配色" subtitle="选择后立即生效，下次打开沿用这份配色。" onClose={onClose}>
    <fieldset className="theme-options">
      <legend className="theme-options-legend">选择工作台配色</legend>
      {THEMES.map(theme => <label className="theme-choice" key={theme.id}>
        <input type="radio" name="workbench-theme" value={theme.id} checked={selected === theme.id} onChange={() => selectTheme(theme.id)} aria-label={theme.name} aria-describedby={`theme-description-${theme.id}`} />
        <span className="theme-choice-content">
          <span className="theme-preview" data-palette={theme.id} aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="theme-choice-copy"><strong>{theme.name}{theme.id === 'cyan' && <small>默认</small>}</strong><span id={`theme-description-${theme.id}`}>{theme.description}</span></span>
          <span className="theme-choice-check" aria-hidden="true">{selected === theme.id && <Check size={16} />}</span>
        </span>
      </label>)}
    </fieldset>
    <div className="modal-footer"><Button className="primary" onClick={onClose}>完成</Button></div>
  </Modal>;
}
