/** Responses arrive only after manifest allowlist, SHA256 and strict schema validation. */
export function replay(id: string, responses: Map<string, unknown>) {
  if (!responses.has(id)) throw Error(`Missing synthetic replay response: ${id}`);
  return structuredClone(responses.get(id));
}
