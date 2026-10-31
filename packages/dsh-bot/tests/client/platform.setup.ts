import { vi } from 'vitest';

// Fake platform atoms, like the fake services used by Client tests. These do
// not validate the host's CSS, SVG artwork or menu placement. Real platform
// rendering is exercised separately by scripts/screenshot.mjs.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./platform-primitives.js'));
vi.mock('@deepseek-ai/dsh-client-ui-input-trigger/client', () => import('./platform-input-trigger.js'));
