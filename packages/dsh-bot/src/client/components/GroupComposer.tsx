import { useEffect, useId, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { MenuSurface, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { createGroupTrigger, GROUP_COMMAND_SOURCE, type GroupCommandSource } from '../group-trigger.js';
import { reconcileMentionBindings, type MentionTarget, type MentionBinding } from '../group-mentions.js';
import styles from '../styles/groups.module.css';
export function GroupComposerInput({ sessionId, text, bindings, targets, inputRef, commands, commandLauncher, onChange, onSubmit, t }: {
  sessionId: string; text: string; bindings: MentionBinding[]; targets: MentionTarget[]; inputRef: RefObject<HTMLTextAreaElement>;
  /** Entries of the leading '/' menu; absent leaves '/' as plain text. */
  commands?: GroupCommandSource;
  /** Receives a toggle for the '/' menu, used by the composer's add button. */
  commandLauncher?: MutableRefObject<(() => void) | undefined>;
  onChange(text: string, bindings: MentionBinding[]): void; onSubmit(): void;
} & PropsLocale<'dsh-bot'>) {
  const latest = useRef({ text, bindings, targets, commands, onChange }); latest.current = { text, bindings, targets, commands, onChange };
  const revision = useRef(0), composing = useRef(false), composition = useRef<ReturnType<typeof observeComposition>>(), menuId = useId();
  const [bridge] = useState(() => createGroupTrigger(sessionId, () => latest.current.targets, (span, memberId, insertion) => {
    const current = latest.current;
    if (span.draftRev !== revision.current) return false;
    const next = current.text.slice(0, span.start) + insertion + current.text.slice(span.end);
    const nextBindings = reconcileMentionBindings(current.text, next, current.bindings).filter(binding => !(binding.start === span.start || (binding.start < 0 && binding.text === insertion.trimEnd())));
    if (memberId !== undefined) nextBindings.push({ start: span.start, end: span.start + insertion.trimEnd().length, text: insertion.trimEnd(), memberId });
    revision.current++; current.onChange(next, nextBindings);
    queueMicrotask(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(span.start + insertion.length, span.start + insertion.length); });
    return true;
  }, () => latest.current.commands));
  useEffect(() => { const input = inputRef.current; if (!input) return; composition.current = observeComposition(input.ownerDocument); return () => { composition.current?.dispose(); bridge.dispose(); }; }, [bridge, inputRef]);
  useEffect(() => {
    if (!commandLauncher) return;
    commandLauncher.current = () => {
      const input = inputRef.current;
      bridge.toggleCommands(input?.selectionStart ?? latest.current.text.length, revision.current);
      // Keyboard arbitration runs in the textarea, as with a typed '/'.
      input?.focus({ preventScroll: true });
    };
    return () => { commandLauncher.current = undefined; };
  }, [bridge, commandLauncher, inputRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Text changes require measuring the controlled textarea after render.
  useEffect(() => { const input = inputRef.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(144, Math.max(56, input.scrollHeight))}px`; } }, [text, inputRef]);
  const menu = useSyncExternalStore(bridge.controller.menu.subscribe, bridge.controller.menu.getSnapshot);
  useEffect(() => { if (menu.open && menu.highlight) document.getElementById(`${menuId}-${menu.highlight.source}-${menu.highlight.index}`)?.scrollIntoView?.({ block: 'nearest' }); }, [menu, menuId]);
  const track = () => { const input = inputRef.current; if (input) bridge.track(latest.current.text, input.selectionStart, revision.current); };
  const commandMenu = menu.hit?.trigger === '/';
  const rows: ReactNode[] = [];
  for (const group of menu.groups) {
    if (group.status !== 'ready') continue;
    const command = group.source === GROUP_COMMAND_SOURCE;
    // Command rows carry native-style sections ("Add", "Commands"); each becomes a labelled group.
    const sections = new Map<string, number[]>();
    group.items.forEach((item, index) => { const key = command ? item.section ?? '' : ''; sections.set(key, [...(sections.get(key) ?? []), index]); });
    for (const [section, indexes] of sections) {
      const options = indexes.map(index => {
        const item = group.items[index]; if (!item) return null;
        const Icon = typeof item.icon === 'function' ? item.icon : undefined;
        return <button type="button" role="option" key={item.name} id={`${menuId}-${group.source}-${index}`}
          data-group-command={command ? item.name : undefined}
          aria-selected={menu.highlight?.source === group.source && menu.highlight.index === index}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => bridge.controller.hover(group.source, index)} onClick={() => bridge.controller.pick(group.source, index)}>
          {Icon && <span className={styles.commandIcon} aria-hidden="true"><Icon size={16} /></span>}
          <strong>{item.label ?? item.name}</strong>
          {command && item.label && item.label !== item.name && <small className={styles.commandAlias}>{item.name}</small>}
          {item.description && <small className={command ? styles.commandHint : undefined}>{item.description}</small>}
        </button>;
      });
      rows.push(section
        // biome-ignore lint/a11y/useSemanticElements: a listbox section is an ARIA group of options; <fieldset> groups form controls.
        ? <div role="group" aria-label={section} key={`${group.source}:${section}`}><div className={styles.commandSection} aria-hidden="true">{section}</div>{options}</div>
        : <div role="presentation" key={`${group.source}:`}>{options}</div>);
    }
  }
  return <div className={styles.mentionInput}>
    <label><span className={styles.srOnly}>{t('groups.message')}</span><textarea ref={inputRef} value={text} placeholder={t(commands ? 'groups.pickCommands' : 'groups.pick')}
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
    {menu.open && rows.length > 0 && <MenuSurface id={menuId} role="listbox" aria-label={t(commandMenu ? 'groups.commands' : 'groups.targets')}
      className={commandMenu ? `${styles.mentionMenu} ${styles.commandMenu}` : styles.mentionMenu} data-group-command-menu={commandMenu ? '' : undefined}>
      {rows}
    </MenuSurface>}
  </div>;
}
