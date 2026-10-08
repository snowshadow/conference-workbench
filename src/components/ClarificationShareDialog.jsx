import { useEffect, useState } from 'react';
import { Check, Copy, Download, LoaderCircle } from 'lucide-react';
import { Button, FormError, Modal } from './ui.jsx';
import { clarificationContent, questionFor } from '../lib/clarification-content.js';
import { clarificationShareContent, clarificationShareFilename, renderClarificationShareImage } from '../lib/clarification-share.js';
import './ClarificationShareDialog.css';

export function ClarificationShareDialog({ item, meeting, onClose }) {
  const content = clarificationContent(item);
  const [includeExplanation, setIncludeExplanation] = useState(!content.distinctions.length);
  const [includeResolution, setIncludeResolution] = useState(['resolved', 'recorded'].includes(item.status));
  const [image, setImage] = useState(null);
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const canCopy = typeof ClipboardItem !== 'undefined' && Boolean(navigator.clipboard?.write);
  useEffect(() => {
    let cancelled = false, url;
    setImage(null); setError(''); setCopied(false);
    renderClarificationShareImage(clarificationShareContent(item, meeting, { includeExplanation, includeResolution })).then(result => {
      if (cancelled) return;
      url = URL.createObjectURL(result.blob);
      setImage({ ...result, url });
    }).catch(failure => { if (!cancelled) setError(failure.message || '图片生成失败，请重试。'); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [item, meeting, includeExplanation, includeResolution, attempt]);
  async function copy() {
    if (!image || copying) return;
    setCopying(true); setError(''); setCopied(false);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })]);
      setCopied(true);
    } catch { setError('无法复制图片，请点击「下载 PNG」保存后分享。'); }
    finally { setCopying(false); }
  }
  return <Modal title="生成分享图" subtitle="一题一张，复制或下载后发给同事。" wide onClose={onClose} closeDisabled={copying}>
    <div className="clarification-share">
      <div className="clarification-share-options">
        {content.explanation && <label className="clarification-share-option"><input type="checkbox" checked={includeExplanation} disabled={copying} onChange={event => { setImage(null); setIncludeExplanation(event.target.checked); }} />附上 AI 解释</label>}
        {item.resolution?.text && <label className="clarification-share-option"><input type="checkbox" checked={includeResolution} disabled={copying} onChange={event => { setImage(null); setIncludeResolution(event.target.checked); }} />附上讨论结果</label>}
      </div>
      <div className="clarification-share-preview" aria-busy={!image && !error}>
        {image ? <img src={image.url} alt={`澄清问题分享图：${questionFor(item)}`} width={image.width} height={image.height} /> : error ? <Button onClick={() => setAttempt(value => value + 1)}>重新生成</Button> : <p role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />正在生成分享图…</p>}
      </div>
      <FormError error={error} />
      <p className="clarification-share-status" role="status">{copied ? '已复制，可直接粘贴到聊天中。' : image ? `${image.width} × ${image.height} · PNG${!canCopy ? ' · 当前浏览器请下载后分享' : ''}` : ''}</p>
    </div>
    <div className="modal-footer">
      {canCopy && <Button disabled={!image} busy={copying} onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制图片' : '复制图片'}</Button>}
      {image ? <a className="button primary" href={image.url} download={clarificationShareFilename(item, meeting)}><Download size={15} />下载 PNG</a> : <Button className="primary" disabled><Download size={15} />下载 PNG</Button>}
    </div>
  </Modal>;
}
