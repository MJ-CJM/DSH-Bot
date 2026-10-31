import { describe, expect, it } from 'vitest';
import { ACTIVITY_HIDDEN_PREVIEW, createActivityPreview } from '../src/host/activity/preview.js';
import { ACTIVITY_PREVIEW_MAX_CHARS, activityRecordSchema, isActivityUnread, isHiddenActivityPreview } from '../src/shared/activity.js';

describe('completed-message activity previews', () => {
  it('accepts proven generation metadata while keeping older records unassigned', () => {
    const legacy = { sessionId: 'legacy', botId: 'alpha', lastMessage: { role: 'assistant', preview: 'Safe', at: 1 }, updatedAt: 1 };
    expect(activityRecordSchema.parse(legacy)).not.toHaveProperty('botCreatedAt');
    expect(activityRecordSchema.parse({ ...legacy, botCreatedAt: 123 })).toHaveProperty('botCreatedAt', 123);
    for (const botCreatedAt of [-1, 0.5, '123', null]) {
      expect(activityRecordSchema.safeParse({ ...legacy, botCreatedAt }).success).toBe(false);
    }
  });

  it('uses a locale-neutral wire sentinel and recognizes persisted legacy markers', () => {
    expect(ACTIVITY_HIDDEN_PREVIEW).toMatch(/^[\x20-\x7e]+$/u);
    for (const marker of [ACTIVITY_HIDDEN_PREVIEW, '[已隐藏]']) {
      expect(isHiddenActivityPreview(marker)).toBe(true);
      expect(activityRecordSchema.parse({ sessionId: 'legacy', botId: 'alpha-bot', title: marker,
        lastMessage: { role: 'assistant', preview: marker, at: 1 }, updatedAt: 1 }).lastMessage.preview).toBe(marker);
    }
    expect(isHiddenActivityPreview('ordinary text')).toBe(false);
  });
  it('collapses whitespace and removes control characters', () => {
    expect(createActivityPreview('  Hello\n\tworld\u0000 你好\u00a0!  ')).toBe('Hello world 你好 !');
    expect(createActivityPreview(' \n\t ')).toBe('');
  });

  it('removes fenced code, images, links and simple formatting', () => {
    expect(createActivityPreview('# **Heading**\n```ts\nconst hidden = 1;\n```\n'
      + '![noisy image](data:image/png;base64,aGVsbG8=)\n[visible](https://example.com) `code` <b>text</b>'))
      .toBe('Heading visible code text');
    expect(createActivityPreview('Before\n~~~js\nunfinished')).toBe('Before');
    expect(createActivityPreview('![alt][ref] after &amp; before')).toBe('after & before');
  });

  it('truncates at 120 code points including ellipsis and leaves exact boundaries intact', () => {
    expect(createActivityPreview('x'.repeat(ACTIVITY_PREVIEW_MAX_CHARS))).toHaveLength(ACTIVITY_PREVIEW_MAX_CHARS);
    expect(createActivityPreview('x'.repeat(ACTIVITY_PREVIEW_MAX_CHARS + 1)))
      .toBe(`${'x'.repeat(ACTIVITY_PREVIEW_MAX_CHARS - 1)}…`);
  });

  it('preserves plain identifiers while removing standalone underscore emphasis', () => {
    expect(createActivityPreview('T08C_LOCAL_MOCK_REPLY path_with_name')).toBe('T08C_LOCAL_MOCK_REPLY path_with_name');
    expect(createActivityPreview('_emphasis_ and __strong__')).toBe('emphasis and strong');
  });

  it('does not split supplementary Unicode characters or count surrogate halves', () => {
    const preview = createActivityPreview('🤖'.repeat(121));
    expect([...preview]).toHaveLength(120);
    expect(preview).toBe(`${'🤖'.repeat(119)}…`);
    expect(preview).not.toContain('\ufffd');
    expect(createActivityPreview('é你好🚀')).toBe('é你好🚀');
  });

  it('reuses every memory secret signature and checks before truncation/markdown removal', () => {
    const secrets = [`sk-${'a'.repeat(24)}`, `ghp_${'A'.repeat(24)}`, `github_pat_${'a'.repeat(24)}`,
      `xoxb-${'a'.repeat(24)}`, `xoxp-${'a'.repeat(24)}`, `AKIA${'A'.repeat(16)}`,
      '-----BEGIN RSA PRIVATE KEY-----'];
    for (const secret of secrets) {
      expect(createActivityPreview(secret)).toBe(ACTIVITY_HIDDEN_PREVIEW);
      expect(createActivityPreview('safe '.repeat(50) + secret)).toBe(ACTIVITY_HIDDEN_PREVIEW);
      expect(createActivityPreview(`Before\n\`\`\`\n${secret}\n\`\`\`\nAfter`)).toBe(ACTIVITY_HIDDEN_PREVIEW);
      expect(createActivityPreview(`![secret](${secret})`)).toBe(ACTIVITY_HIDDEN_PREVIEW);
    }
  });

  it('checks normalized and markup-joined credentials without rejecting ordinary code', () => {
    expect(createActivityPreview(`ｓｋ－${'ａ'.repeat(24)}`)).toBe(ACTIVITY_HIDDEN_PREVIEW);
    expect(createActivityPreview(`sk-**${'a'.repeat(12)}**${'a'.repeat(12)}`)).toBe(ACTIVITY_HIDDEN_PREVIEW);
    expect(createActivityPreview(`ghp_<b>${'a'.repeat(24)}</b>`)).toBe(ACTIVITY_HIDDEN_PREVIEW);
    expect(createActivityPreview(`ghp_**${'a'.repeat(24)}**`)).toBe(ACTIVITY_HIDDEN_PREVIEW);
    expect(createActivityPreview('Use sk- prefix or -----BEGIN PUBLIC KEY-----')).toBe('Use sk- prefix or -----BEGIN PUBLIC KEY-----');
  });
});

describe('activity unread rule', () => {
  it('only counts assistant messages strictly after lastReadAt', () => {
    for (const role of ['user', 'assistant'] as const) {
      for (const [at, lastReadAt, unread] of [[2, undefined, true], [2, 1, true], [2, 2, false], [2, 3, false], [0, undefined, false]] as const) {
        expect(isActivityUnread({ lastMessage: { role, preview: 'text', at }, lastReadAt }))
          .toBe(role === 'assistant' && unread);
      }
    }
  });
});
