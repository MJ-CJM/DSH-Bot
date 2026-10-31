import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { MenuSurface, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { createGroupTrigger } from '../group-trigger.js';
import { reconcileMentionBindings, type MentionTarget, type MentionBinding } from '../group-mentions.js';
import styles from '../styles/groups.module.css';
export function GroupComposerInput({ sessionId, text, bindings, targets, inputRef, onChange, onSubmit, t }: {
  sessionId: string; text: string; bindings: MentionBinding[]; targets: MentionTarget[]; inputRef: RefObject<HTMLTextAreaElement>;
  onChange(text: string, bindings: MentionBinding[]): void; onSubmit(): void;
} & PropsLocale<'dsh-bot'>) {
  const latest = useRef({ text, bindings, targets, onChange }); latest.current = { text, bindings, targets, onChange };
  const revision = useRef(0), composing = useRef(false), composition = useRef<ReturnType<typeof observeComposition>>(), menuId = useId();
  const [bridge] = useState(() => createGroupTrigger(sessionId, () => latest.current.targets, (span, memberId, insertion) => {
    const current = latest.current;
    if (span.draftRev !== revision.current) return false;
    const next = current.text.slice(0, span.start) + insertion + current.text.slice(span.end);
    const nextBindings = reconcileMentionBindings(current.text, next, current.bindings).filter(binding => !(binding.start === span.start || (binding.start < 0 && binding.text === insertion.trimEnd())));
    nextBindings.push({ start: span.start, end: span.start + insertion.trimEnd().length, text: insertion.trimEnd(), memberId });
    revision.current++; current.onChange(next, nextBindings);
    queueMicrotask(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(span.start + insertion.length, span.start + insertion.length); });
    return true;
  }));
  useEffect(() => { const input = inputRef.current; if (!input) return; composition.current = observeComposition(input.ownerDocument); return () => { composition.current?.dispose(); bridge.dispose(); }; }, [bridge, inputRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Text changes require measuring the controlled textarea after render.
  useEffect(() => { const input = inputRef.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(144, Math.max(56, input.scrollHeight))}px`; } }, [text, inputRef]);
  const menu = useSyncExternalStore(bridge.controller.menu.subscribe, bridge.controller.menu.getSnapshot);
  useEffect(() => { if (menu.open && menu.highlight) document.getElementById(`${menuId}-${menu.highlight.source}-${menu.highlight.index}`)?.scrollIntoView?.({ block: 'nearest' }); }, [menu, menuId]);
  const track = () => { const input = inputRef.current; if (input) bridge.track(latest.current.text, input.selectionStart, revision.current); };
  return <div className={styles.mentionInput}>
    <label><span className={styles.srOnly}>{t('groups.message')}</span><textarea ref={inputRef} value={text} placeholder={t('groups.pick')}
      aria-controls={menu.open ? menuId : undefined} aria-autocomplete="list" aria-activedescendant={menu.open && menu.highlight ? `${menuId}-${menu.highlight.source}-${menu.highlight.index}` : undefined}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; track(); }}
      onSelect={track} onClick={track}
      onChange={event => { const next = event.target.value; revision.current++; onChange(next, reconcileMentionBindings(text, next, bindings)); bridge.track(next, event.target.selectionStart, revision.current); }}
      onKeyDown={event => {
        if (composition.current?.guards(event.nativeEvent) || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const key = ({ ArrowDown: 'down', ArrowUp: 'up', Enter: 'enter', Tab: event.shiftKey ? 'tabBack' : 'tab', Escape: 'escape' } as const)[event.key as 'Enter'];
        if (key && bridge.controller.arbitrate(key, false) !== 'pass') { event.preventDefault(); return; }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSubmit(); }
      }}
    /></label>
    {menu.open && <MenuSurface id={menuId} role="listbox" aria-label={t('groups.targets')} className={styles.mentionMenu}>
      {menu.groups.flatMap(group => group.status === 'ready' ? group.items.map((item, index) => <button type="button" role="option" key={item.name}
        id={`${menuId}-${group.source}-${index}`} aria-selected={menu.highlight?.source === group.source && menu.highlight.index === index}
        onMouseDown={event => event.preventDefault()} onClick={() => bridge.controller.pick(group.source, index)}>
        <strong>{item.label}</strong> <small>{item.description}</small>
      </button>) : [])}
    </MenuSurface>}
  </div>;
}
