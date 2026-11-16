/** Command registration, normalized default bindings, and synchronous dispatch. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindingIssue, bindingKey, effectiveShortcuts, initialShortcutConfig, isWebBindingAllowed, normalizeBinding, overlappingBindings, presentBinding, resolveShortcutDefault } from '../protocol.ts'
import type { ShortcutCommandId, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutPlatform, ShortcutRuntime } from '../protocol.ts'
import type { ShortcutCatalogEntry, ShortcutCommand, ShortcutContext, ShortcutGesture,
  ShortcutFixedCommand, ShortcutFixedCatalogEntry, ShortcutCommandMode, ShortcutResolution, ShortcutModePresentation } from './types.ts'

/** Dispatch consumption is independent of later business-operation success. */
type ShortcutDispatch = { status: 'handled'; commandId: ShortcutCommandId }
  | { status: 'blocked'; commandId: ShortcutCommandId; reason: string }
  | { status: 'pass' }

/** Application command registry; adapters own event listeners, feature plugins own actions. */
export class ShortcutRegistry {
  private readonly modes = new Map<string, ShortcutCommandMode>()
  private readonly commands = new Map<ShortcutCommandId, ShortcutCommand>()
  private readonly fixedCommands = new Map<ShortcutCommandId, ShortcutFixedCommand>()
  private readonly conflicts = new Map<string, ShortcutCommand>()
  private readonly bindings = new Map<string, ShortcutCommand>()
  private readonly state
  /** Effective localized rows derived from the accepted configuration. */
  readonly catalog
  /** Accepted preferences and visible read diagnostics. */
  readonly config
  /** Fixed local operations whose owning plugins are mounted. */
  readonly modePresentation = createSnapshotStore<readonly ShortcutModePresentation[]>([])
  readonly fixedCatalog = createSnapshotStore<readonly ShortcutFixedCatalogEntry[]>([])

  constructor(readonly runtime: ShortcutRuntime, readonly platform: ShortcutPlatform,
    config: ShortcutConfigSnapshot = { ...initialShortcutConfig(), status: 'ready' }) {
    this.state = createSnapshotStore<{ catalog: readonly ShortcutCatalogEntry[]; config: ShortcutConfigSnapshot }>({ catalog: [], config })
    this.catalog = { getSnapshot: () => this.state.getSnapshot().catalog,
      subscribe: (listener: () => void) => this.state.subscribe(listener) }
    this.config = { getSnapshot: () => this.state.getSnapshot().config,
      subscribe: (listener: () => void) => this.state.subscribe(listener) }
  }

  /**
   * Return the serializable active catalog for storage validation.
   * @returns definitions without callbacks or localized labels.
   */
  definitions(): readonly ShortcutDefinition[] {
    return [...[...this.commands.values()].map(({ id, defaults }) => ({ id, defaults })),
      ...[...this.fixedCommands.values()].map(({ id, bindings }) => ({ id, defaults: {}, fixed: bindings }))]
  }

  /**
   * Register a read-only input action whose keys cannot be assigned to editable commands.
   * @param command - owner-localized action and readable sequence.
   * @returns idempotent disposer removing its reference row.
   */
  registerFixed(command: ShortcutFixedCommand): () => void {
    if (this.fixedCommands.has(command.id) || this.commands.has(command.id)) throw new Error(`Duplicate shortcut command: ${command.id}`)
    for (const binding of command.bindings) normalizeBinding(binding, this.platform)
    this.fixedCommands.set(command.id, command)
    this.refreshLabels()
    return () => {
      if (this.fixedCommands.get(command.id) !== command) return
      this.fixedCommands.delete(command.id)
      this.refreshLabels()
    }
  }

  private refreshFixedLabels(): void {
    this.fixedCatalog.set([...this.fixedCommands.values()].map(command => ({
      id: command.id, label: command.label(), keys: command.keys, group: command.group,
      bindings: command.bindings.map(binding => normalizeBinding(binding, this.platform)),
    })))
  }

  /**
   * Publish accepted preferences and all derived labels atomically.
   * @param config - storage owner's latest accepted snapshot.
   */
  configure(config: ShortcutConfigSnapshot): void {
    const current = this.config.getSnapshot()
    if (config.revision === current.revision && config.status === current.status && config.error === current.error) return
    this.refreshLabels(config)
  }

  /**
   * Register atomically after checking defaults for all supported platforms and shells.
   * @param command - feature-owned command definition.
   * @returns idempotent disposer removing both matching and catalog entries.
   */
  register(command: ShortcutCommand): () => void {
    if (this.commands.has(command.id) || this.fixedCommands.has(command.id)) throw new Error(`Duplicate shortcut command: ${command.id}`)
    for (const runtime of ['desktop', 'web'] as const) {
      for (const platform of ['macos', 'windows', 'linux'] as const) {
        const candidate = resolveShortcutDefault(command, runtime, platform)
        if (candidate === undefined) continue
        const binding = normalizeBinding(candidate, platform)
        if (runtime === 'web' && !isWebBindingAllowed(binding, platform)) {
          throw new Error(`Unsupported Web shortcut: ${command.id}`)
        }
        if (bindingIssue(binding, runtime, platform) !== null) throw new Error(`Reserved shortcut default: ${command.id}`)
        for (const existing of this.commands.values()) {
          const other = resolveShortcutDefault(existing, runtime, platform)
          if (other !== undefined && overlappingBindings(binding, normalizeBinding(other, platform))) {
            throw new Error(`Conflicting shortcut defaults: ${command.id} and ${existing.id} (${runtime}:${platform})`)
          }
        }
      }
    }
    this.commands.set(command.id, command)
    this.refreshLabels()
    return () => {
      if (this.commands.get(command.id) !== command) return
      this.commands.delete(command.id)
      this.refreshLabels()
    }
  }

  /** Register an immutable mode snapshot. Hidden commands remain in the match tables. */
  registerCommandMode(input: ShortcutCommandMode): () => void {
    if (!input.id || !Number.isFinite(input.priority)) throw new Error('Invalid shortcut command mode')
    if (this.modes.has(input.id)) throw new Error(`Duplicate shortcut mode: ${input.id}`)
    const commands = Object.freeze(Object.fromEntries(Object.entries(input.commands).map(([id, row]) => {
      if (typeof row.resolve !== 'function' || (row.label !== undefined && typeof row.label !== 'function')
        || (row.hidden !== undefined && typeof row.hidden !== 'boolean')) throw new Error('Invalid shortcut command mode entry')
      for (const mode of this.modes.values()) {
        if (mode.priority === input.priority && Object.hasOwn(mode.commands, id)) {
          throw new Error(`Conflicting shortcut modes: ${input.id} and ${mode.id} (${id})`)
        }
      }
      return [id, Object.freeze({ ...row })]
    })))
    const mode = Object.freeze({ id: input.id, priority: input.priority, commands })
    this.modes.set(mode.id, mode)
    try { this.refreshLabels() } catch (error) { this.modes.delete(mode.id); this.refreshLabels(); throw error }
    return () => {
      if (this.modes.get(mode.id) !== mode) return
      this.modes.delete(mode.id)
      this.refreshLabels()
    }
  }

  private commandModes(id: string) {
    return [...this.modes.values()].filter(mode => Object.hasOwn(mode.commands, id))
      .sort((left, right) => right.priority - left.priority)
  }

  resolveCommandMode(id: string, context: ShortcutContext): ShortcutResolution {
    for (const mode of this.commandModes(id)) {
      const result = mode.commands[id]!.resolve(context)
      if (result.status !== 'pass') return result
    }
    return { status: 'pass' }
  }

  private resolveCommand(command: ShortcutCommand, context: ShortcutContext): ShortcutResolution {
    const result = this.resolveCommandMode(command.id, context)
    return result.status === 'pass' ? command.resolve(context) : result
  }

  private refreshModePresentation(): void {
    const ids = new Set([...this.modes.values()].flatMap(mode => Object.keys(mode.commands)))
    this.modePresentation.set([...ids].map(id => {
      const rows = this.commandModes(id)
      const label = rows.find(mode => mode.commands[id]!.label !== undefined)?.commands[id]!.label
      return { id, hidden: rows.find(mode => mode.commands[id]!.hidden !== undefined)?.commands[id]!.hidden ?? false,
        ...(label === undefined ? {} : { label: label() }) }
    }))
  }

  /**
   * Recompute effective bindings when preferences, commands, or locale change.
   * @param config - accepted configuration, defaulting to the current snapshot.
   */
  refreshLabels(config: ShortcutConfigSnapshot = this.config.getSnapshot()): void {
    this.refreshModePresentation()
    this.bindings.clear()
    this.conflicts.clear()
    const rows = effectiveShortcuts(this.definitions(), config.document, this.runtime, this.platform)
    const catalog = rows.map((row) => {
      const command = this.commands.get(row.id) as ShortcutCommand
      const enabled = config.status !== 'loading' && row.issue === null && row.conflicts.length === 0
      if (enabled && row.binding !== null) this.bindings.set(bindingKey(row.binding), command)
      if (config.status !== 'loading' && row.issue === null && row.conflicts.length > 0 && row.binding !== null) {
        this.conflicts.set(bindingKey(row.binding), command)
      }
      const presentation = this.commandModes(command.id)
      const label = presentation.find(mode => mode.commands[command.id]!.label !== undefined)?.commands[command.id]!.label
      const hidden = presentation.find(mode => mode.commands[command.id]!.hidden !== undefined)?.commands[command.id]!.hidden ?? false
      return { ...row, hidden, label: label === undefined ? command.label() : label(), aliases: command.aliases,
        ...presentBinding(row.binding, this.platform),
        aria: enabled ? presentBinding(row.binding, this.platform).aria : undefined }
    })
    this.state.set({ config, catalog: catalog.filter(row => !row.hidden).map(({ hidden: _hidden, ...row }) => row) })
    this.refreshFixedLabels()
  }

  /**
   * Invoke a native menu selection independently of its optional key binding.
   * @param id - registered product command.
   * @param context - live input owner and modal state.
   */
  invoke(id: ShortcutCommandId, context: ShortcutContext): void {
    const command = this.commands.get(id)
    if (command === undefined || (context.modal !== null && !command.modals.includes(context.modal))) return
    const result = this.resolveCommand(command, { ...context, source: 'menu' })
    if (result.status === 'handled') result.run()
  }

  /**
   * Windows/macOS Desktop bindings override local regions and modal controls independently of their configuration source.
   * @param gesture - normalized DOM/native input facts.
   * @param context - synchronous input and modal owner.
   * @param consume - adapter's preventDefault, called before business execution.
   * @returns handled, blocked with a reason, or pass for local/system input.
   */
  dispatch(gesture: ShortcutGesture, context: ShortcutContext, consume: () => void): ShortcutDispatch {
    if (gesture.defaultPrevented || gesture.composing) return { status: 'pass' }
    const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter(value => gesture[value])
    const pairKey = bindingKey({ code: gesture.code, modifiers,
      ...(gesture.secondCode === undefined ? {} : { secondCode: gesture.secondCode }) })
    const key = this.bindings.has(pairKey) || this.conflicts.has(pairKey) ? pairKey : bindingKey({ code: gesture.code, modifiers })
    const command = this.bindings.get(key) ?? this.conflicts.get(key)
    const priority = this.runtime === 'desktop' && (this.platform === 'windows' || this.platform === 'macos')
    if (command === undefined || (!priority && !command.regions.includes(context.region))) return { status: 'pass' }
    if (!priority && context.region === 'terminal' && gesture.control && !gesture.meta && !gesture.alt && !gesture.shift
      && (gesture.code === 'KeyW' || gesture.code === 'KeyR')) return { status: 'pass' }
    if (!this.bindings.has(key)) {
      consume()
      return { status: 'blocked', commandId: command.id, reason: 'conflict' }
    }
    if (!priority && context.modal !== null && !command.modals.includes(context.modal)) {
      consume()
      return { status: 'blocked', commandId: command.id, reason: 'modal' }
    }
    const resolution = this.resolveCommand(command, context)
    if (resolution.status === 'pass') return resolution
    consume()
    if (resolution.status === 'blocked') return { ...resolution, commandId: command.id }
    if (!gesture.repeat) resolution.run()
    return { status: 'handled', commandId: command.id }
  }
}
