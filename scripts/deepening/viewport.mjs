import assert from 'node:assert/strict';

/** Document scrollWidth misses overflow hidden by the native panel's scroll container. */
export async function assertMemoryViewport(panel, width) {
  const geometry = await panel.evaluate(element => {
    const nodes = [element, ...element.querySelectorAll('aside, [role=tablist], form, fieldset, p, button, input, textarea, select, label')];
    return nodes.filter(node => node.getClientRects().length).map(node => {
      const rect = node.getBoundingClientRect();
      return { tag: node.tagName, role: node.getAttribute('role'), label: node.getAttribute('aria-label'),
        left: rect.left, right: rect.right, client: node.clientWidth, scroll: node.scrollWidth,
        container: node.matches('section, aside, [role=tablist], form, fieldset') };
    });
  });
  const overflow = geometry.filter(row => row.left < -1 || row.right > width + 1 || row.container && row.scroll > row.client + 1);
  assert.deepEqual(overflow, [], `Memory panel overflow at ${width}px: ${JSON.stringify(overflow)}`);
  return geometry;
}
