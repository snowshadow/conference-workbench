import { Activity, Component, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, Maximize2, Minimize2, X, LoaderCircle } from 'lucide-react';

export function IconButton({ title, children, className = '', ...props }) {
  return <button type="button" className={`icon-button ${className}`} title={title} aria-label={title} {...props}>{children}</button>;
}

export function Button({ children, busy = false, disabled = false, className = '', ...props }) {
  return <button type="button" className={`button ${className}`} {...props} disabled={busy || disabled} aria-busy={busy || props['aria-busy'] || undefined}>{busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}{children}</button>;
}

export function EmptyState({ icon: Icon, title, children, action, compact = false }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}>
    {Icon && <div className="empty-icon"><Icon size={compact ? 22 : 28} strokeWidth={1.5} /></div>}
    <h3>{title}</h3>{children && <p>{children}</p>}{action}
  </div>;
}

export class PanelErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('讨论面板加载失败', error); }
  render() { return this.state.error ? this.props.fallback : this.props.children; }
}

export function Modal({ title, subtitle, onClose, children, wide = false, closeDisabled = false }) {
  const dialog = useRef(null);
  const titleId = useId(), subtitleId = useId();
  const latest = useRef({ onClose, closeDisabled });
  const closing = useRef(false);
  const backdropPress = useRef(false);
  const animation = useRef(null);
  latest.current = { onClose, closeDisabled };
  const requestClose = () => {
    if (latest.current.closeDisabled || closing.current) return;
    closing.current = true;
    animation.current?.cancel();
    latest.current.onClose();
  };
  useLayoutEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    closing.current = false;
    element.showModal();
    if (!motion.matches && element.animate) {
      animation.current = element.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    const stopMotion = () => { if (motion.matches) animation.current?.cancel(); };
    motion.addEventListener('change', stopMotion);
    return () => {
      animation.current?.cancel();
      motion.removeEventListener('change', stopMotion);
      closing.current = true;
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  const outside = event => {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  return <dialog ref={dialog} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined} aria-busy={closeDisabled || undefined}
    onCancel={event => { event.preventDefault(); requestClose(); }}
    onPointerDown={event => { backdropPress.current = event.button === 0 && outside(event); }}
    onPointerCancel={() => { backdropPress.current = false; }}
    onClick={event => { const dismiss = backdropPress.current && outside(event); backdropPress.current = false; if (dismiss) requestClose(); }}>
    <div className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div><IconButton title="关闭" onClick={requestClose} disabled={closeDisabled}><X size={19} aria-hidden="true" /></IconButton></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}

export function FormError({ error, id }) { return error ? <p id={id} className="form-error" role="alert">{error}</p> : null; }

export function useFormAction(action) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const submit = async event => {
    event?.preventDefault?.();
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(failure.message || '操作失败，请重试。'); } finally { pending.current = false; setBusy(false); }
  };
  return { submit, busy, error };
}

function PanelContent({ children, id }) {
  const content = useRef(null);
  useLayoutEffect(() => {
    const element = content.current;
    // Activity keeps media DOM and its playback position. Pause it when hidden.
    return () => { element?.querySelectorAll('audio, video').forEach(media => media.pause()); };
  }, []);
  return <div ref={content} id={id} className="panel-body">{children}</div>;
}

export function Panel({ title, icon: Icon, eyebrow, actions, children, id, focus, setFocus, collapsed, onCollapse, className = '' }) {
  const bodyId = useId();
  return <section className={`panel ${collapsed ? 'is-collapsed' : ''} ${focus === id ? 'is-focused' : ''} ${className}`} aria-label={title}>
    <div className="panel-header"><div className="panel-title">{Icon && <Icon size={17} />}<h2>{title}</h2>{eyebrow && <span className="panel-eyebrow">{eyebrow}</span>}</div>
      <div className="panel-actions">{actions}<IconButton title={focus === id ? '恢复布局' : '放大面板'} onClick={() => setFocus(focus === id ? null : id)}>{focus === id ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</IconButton><IconButton title={collapsed ? '展开面板' : '折叠面板'} aria-expanded={!collapsed} aria-controls={bodyId} onClick={onCollapse}>{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</IconButton></div>
    </div><Activity mode={collapsed ? 'hidden' : 'visible'}><PanelContent id={bodyId}>{children}</PanelContent></Activity>
  </section>;
}

export function Evidence({ ids = [], onSelect, compact = false }) {
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  return <span className={`evidence ${compact ? 'compact' : ''}`}>{unique.map((id, index) => <button key={id} title="定位引用原文并回听" onClick={event => { event.stopPropagation(); onSelect(id); }}><ArrowUpRight size={11} />原文{unique.length > 1 ? ` ${index + 1}` : ''}</button>)}</span>;
}

export function ResizeHandle({ orientation = 'vertical', value, onChange, min, max, reverse = false, label }) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  const frame = useRef(null), pendingValue = useRef(null);
  const latest = useRef({ onChange, min, max });
  latest.current = { onChange, min, max };
  const clamp = next => Math.max(latest.current.min, Math.min(latest.current.max, next));
  const flush = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (pendingValue.current !== null) { const next = pendingValue.current; pendingValue.current = null; latest.current.onChange(clamp(next)); }
  };
  const queue = next => { pendingValue.current = next; if (frame.current === null) frame.current = requestAnimationFrame(flush); };
  const position = event => {
    const active = drag.current;
    const coordinate = orientation === 'vertical' ? event.clientX : event.clientY;
    return clamp(active.value + (coordinate - active.coordinate) * (reverse ? -1 : 1));
  };
  const finish = (event, commit) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (commit) { pendingValue.current = position(event); flush(); }
    else { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; pendingValue.current = null; }
    drag.current = null;
    setDragging(false);
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
  };
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; pendingValue.current = null;
    const active = drag.current; drag.current = null;
    if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
  }, []);
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation={orientation} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} 像素`} style={{ touchAction: 'none' }}
    className={`resize-handle ${orientation} ${dragging ? 'dragging' : ''}`}
    onPointerDown={event => { if (event.button !== 0 || drag.current) return; drag.current = { pointerId: event.pointerId, target: event.currentTarget, coordinate: orientation === 'vertical' ? event.clientX : event.clientY, value }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true }); setDragging(true); event.preventDefault(); }}
    onPointerMove={event => { if (drag.current?.pointerId === event.pointerId) queue(position(event)); }}
    onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)} onLostPointerCapture={event => finish(event, false)}
    onKeyDown={event => {
      const previous = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      const next = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
      if (![previous, next, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const updated = event.key === 'Home' ? min : event.key === 'End' ? max : value + (event.key === next ? 1 : -1) * (event.shiftKey ? 48 : 16) * (reverse ? -1 : 1);
      onChange(clamp(updated));
    }}><span /></div>;
}
