import { useLayoutEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { IconButton } from './ui.jsx';
import '../meeting-tools.css';

export default function MeetingToolWindow({ id, title, active, onClose, children, className = '' }) {
  const windowRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!active) return;
    const element = windowRef.current;
    const opener = document.activeElement;
    if (!document.querySelector('dialog[open]')) element.focus({ preventScroll: true });

    const escape = event => {
      // Native editor dialogs own Escape while open, even when nested in a tool.
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      const meetingMenu = document.querySelector('.discussion-options[open]');
      if (meetingMenu) {
        meetingMenu.open = false;
        meetingMenu.querySelector('summary')?.focus({ preventScroll: true });
        return;
      }
      const focusedDetails = document.activeElement?.closest('details[open]');
      const expandedDetails = focusedDetails && element.contains(focusedDetails) ? focusedDetails : element.querySelector('details[open]');
      if (expandedDetails) {
        expandedDetails.open = false;
        expandedDetails.querySelector('summary')?.focus({ preventScroll: true });
        return;
      }
      closeRef.current();
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      element.querySelectorAll('audio, video').forEach(media => media.pause());
      // Wait for all tools to receive their active state before restoring focus.
      // In a tool switch the new window owns focus; the old one must not steal it.
      queueMicrotask(() => {
        if (document.querySelector('.meeting-tool-window:not([hidden]), dialog[open]')) return;
        const focused = document.activeElement;
        if (focused && focused !== document.body && !element.contains(focused)) return;
        const canFocus = candidate => candidate instanceof HTMLElement && candidate.isConnected && !candidate.closest('[hidden], [inert]');
        const launcher = document.querySelector(`[aria-controls="${CSS.escape(id)}"]`);
        const target = canFocus(opener) ? opener : canFocus(launcher) ? launcher : null;
        target?.focus({ preventScroll: true });
      });
    };
  }, [active, id]);

  return <section ref={windowRef} id={id} className={`meeting-tool-window ${className}`} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} tabIndex={-1} hidden={!active} inert={!active}>
    <header className="meeting-tool-window-header">
      <div className="meeting-tool-window-title"><h2 id={`${id}-title`}>{title}</h2></div>
      <IconButton title={`收起${title}`} onClick={onClose}><ChevronDown size={18} aria-hidden="true" /></IconButton>
    </header>
    <div className="meeting-tool-window-body">{children}</div>
  </section>;
}
