// @vitest-environment jsdom
import { fireEvent, getByRole, getByLabelText } from '@testing-library/dom';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { ProactiveSetup } from '../../src/client/proactive/ProactiveSetup.js';

test('advanced source setup validates GitHub input and preserves an unknown reply', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const setup = vi.fn().mockRejectedValueOnce(new Error('Native remount')).mockResolvedValue('credential-missing');
  const refresh = vi.fn(async () => {});
  const props: ComponentProps<typeof ProactiveSetup> = { setup, refresh, t: ((key: string) => key) as ComponentProps<typeof ProactiveSetup>['t'] };
  try {
    await act(async () => root.render(<ProactiveSetup {...props} />));
    expect(container.textContent).toContain('proactive.setup.noSource');
    const details = container.querySelector('details');
    if (!details) throw new Error('Source setup is missing');
    details.open = true;
    const save = getByRole(container, 'button', { name: 'proactive.setup.saveSource' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () => fireEvent.change(getByLabelText(container, 'proactive.setup.repository'), { target: { value: 'owner/repo' } }));
    expect(save.disabled).toBe(false);
    await act(async () => fireEvent.click(save));
    expect(container.textContent).toContain('proactive.setup.unknown'); expect(refresh).toHaveBeenCalledOnce();
    await act(async () => fireEvent.click(save));
    expect(setup).toHaveBeenLastCalledWith({ action: 'connect-github', repository: 'owner/repo', branch: 'main', credentialRef: 'GITHUB_TOKEN' });
    expect(container.textContent).toContain('proactive.setup.credential-missing');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
