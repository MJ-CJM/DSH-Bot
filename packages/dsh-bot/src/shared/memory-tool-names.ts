/** Only exact built-in names are migrated; MCP/qualified community tool names are untouched. */
const renamed: Readonly<Record<string, string>> = {
  memory_save: 'bot_memory_save', memory_search: 'bot_memory_search',
  memory_list: 'bot_memory_list', memory_forget: 'bot_memory_forget',
};
export const migrateMemoryDeny = (names: readonly string[]) => [...new Set(names.map(name => renamed[name] ?? name))];
export const replacementMemoryTool = (name: string): string | undefined => renamed[name];
