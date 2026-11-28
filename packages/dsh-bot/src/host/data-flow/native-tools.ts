/** Closed native tool catalog. Names alone never grant execution authority. */
export const NATIVE_TOOL_NAMES = [
  'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh',
  'web_search', 'web_fetch', 'skill', 'present', 'job_output', 'job_list', 'job_kill',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'list_agents', 'send_message', 'interrupt_agent', 'ask_user_question', 'todo_write',
  'get_goal', 'create_goal', 'update_goal', 'bot_manage',
] as const;
