import { createContext } from 'react';

/** Occurrence-local presentation only. Native/ordinary conversations retain
 * their existing identity dock, regardless of the global mode setting. */
export const BotModePresentation = createContext(false);
