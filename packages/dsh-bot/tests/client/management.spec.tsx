// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { bot, button, click, field, fill, mountClient, loadBuiltClient } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { botExportSchema, importPreviewSchema } from '../../src/shared/workspace.js';
import {
  graphBindingSchema,
  REFERENCE_SOURCE,
  REFERENCE_VERSION,
  type GraphStatus,
} from '../../src/shared/reference-memory.js';
const document = botExportSchema.parse({
  format: 'dsh-bot-export',
  version: 1,
  bot: { name: 'Portable' },
});
describe('built Client management workspace', () => {
  it.each(['en', 'zh'] as const)(
    '%s preserves graph drafts, focus and DOM across background reset; uses the exact Bot birthday',
    async (language) => {
      const key = { botId: 'alpha', botCreatedAt: 1 };
      let status: GraphStatus = {
        bot: key,
        state: 'internal',
        toolCount: 0,
        writer: false,
        copies: [],
      };
      const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], language, (remote) => {
        remote.workspaceManagement.request.mockResolvedValue({
          ok: true,
          value: {
            kind: 'summary',
            summary: {
              available: false,
              sampleSize: 0,
              accepted: 0,
              completed: 0,
              failed: 0,
              unknown: 0,
            },
          },
        });
        remote.referenceMemory.request.mockImplementation(async (input) => {
          if (input.action === 'configure')
            status = {
              ...status,
              state: 'ready',
              writer: true,
              toolCount: 9,
              binding: graphBindingSchema.parse({
                bot: key,
                mode: input.mode,
                provider: 'mcp-reference',
                packageVersion: REFERENCE_VERSION,
                sourceCommit: REFERENCE_SOURCE,
                scope: 'main-only',
                revision: 1,
                fileIdentity: 'a'.repeat(64),
              }),
            };
          return { ok: true, value: { status } };
        });
      }, {}, loadBuiltClient());
      const t = (language === 'en' ? en : zh).ui;
      try {
        await click(button(app.container, t['manage.title']));
        expect(app.container.textContent).toContain(t['manage.unknown']);
        await click(button(app.container, t['manage.graph']));
        await vi.waitFor(() => expect(button(app.container, t['graph.enable']).disabled).toBe(false));
        await click(button(app.container, t['graph.enable']));
        expect(app.remote.referenceMemory.request).toHaveBeenCalledWith({
          action: 'configure',
          bot: key,
          mode: 'internal+reference-graph',
          expectedRevision: 0,
        });
        const draft = field(app.container, t['graph.observation']) as HTMLTextAreaElement;
        await fill(draft, 'Retain this graph draft');
        draft.focus();
        draft.setSelectionRange(2, 8);
        const node = app.container.querySelector('section[aria-label]');
        await act(async () => {
          await app.ctx.emit('connection/reset');
        });
        expect(field(app.container, t['graph.observation'])).toBe(draft);
        expect(draft.value).toBe('Retain this graph draft');
        expect(documentActive()).toBe(draft);
        expect(draft.selectionStart).toBe(2);
        expect(app.container.querySelector('section[aria-label]')).toBe(node);
        await click(button(app.container, t['manage.transfer']));
        const calls = app.remote.referenceMemory.request.mock.calls.length;
        await act(async () => {
          await app.ctx.emit('connection/reset');
        });
        expect(app.remote.referenceMemory.request.mock.calls.length).toBe(calls);
      } finally {
        await app.dispose();
      }
    },
  );
  it('previews an import before confirmation and invalidates confirmation when the document or destination changes', async () => {
    const preview = importPreviewSchema.parse({
      id: 'preview:test',
      newId: 'portable',
      digest: 'x',
      files: ['SKILL.md'],
      memories: 2,
      connectorRefs: ['github'],
      missingConnectorRefs: ['github'],
      conflict: false,
      phase: 'preview',
    });
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], 'en', (remote) => {
      remote.workspaceManagement.request.mockImplementation(async (input) => {
        if (input.action === 'summary')
          return {
            ok: true,
            value: {
              kind: 'summary',
              summary: {
                available: true,
                sampleSize: 3,
                accepted: 1,
                completed: 1,
                failed: 0,
                unknown: 1,
              },
            },
          };
        return {
          ok: true,
          value: {
            kind: 'preview',
            preview: {
              ...preview,
              phase: input.action === 'import' ? 'committed' : 'preview',
            },
          },
        };
      });
    }, {}, loadBuiltClient());
    const t = en.ui;
    try {
      await click(button(app.container, t['manage.title']));
      await click(button(app.container, t['manage.transfer']));
      await fill(field(app.container, t['manage.document']), JSON.stringify(document));
      await fill(field(app.container, t['manage.newId']), 'portable');
      expect(app.remote.workspaceManagement.request.mock.calls.some(([r]) => r.action === 'import')).toBe(false);
      await click(button(app.container, t['manage.preview']));
      expect(app.container.textContent).toContain('SKILL.md');
      expect(app.container.textContent).toContain(t['manage.unmapped']);
      const input = field(app.container, t['manage.document']);
      input.focus();
      await act(async () => {
        await app.ctx.emit('connection/reset');
      });
      expect(field(app.container, t['manage.document'])).toBe(input);
      await fill(field(app.container, t['manage.newId']), 'other');
      expect(app.container.textContent).not.toContain(t['manage.confirmImport']);
      await click(button(app.container, t['manage.preview']));
      await click(button(app.container, t['manage.confirmImport']));
      expect(app.remote.workspaceManagement.request).toHaveBeenCalledWith({
        action: 'import',
        previewId: preview.id,
        confirmed: true,
      });
    } finally {
      await app.dispose();
    }
  });
});
function documentActive() {
  return globalThis.document.activeElement;
}
