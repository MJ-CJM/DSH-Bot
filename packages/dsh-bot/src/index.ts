// Keep the existing package entry while compiling shared and Host modules together.
export { name, inject, Config, DshBotRegistry, apply } from './host/index.js';
export { VERSION } from './shared/version.js';
