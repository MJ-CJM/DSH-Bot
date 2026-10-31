import { useEffect, useState, type ReactNode } from 'react';
/** Keep an opened section's DOM and drafts, without mounting unopened sections. */
export function RetainedPanel({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return active || visited ? (
    <div hidden={!active} role="tabpanel">
      {children}
    </div>
  ) : null;
}
