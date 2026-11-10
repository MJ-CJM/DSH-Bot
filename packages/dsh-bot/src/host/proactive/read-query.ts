import { createHash } from 'node:crypto';
import { maxReadBytes, readPageBytes, replySchema, type Reply, type RequestBody } from '../../shared/proactive/protocol.js';

/** Keeps the existing typed query API. Large read snapshots cross the bounded
 * IPC in pages; only read-only requests may restart once after invalidation. */
export async function readQuery(body: RequestBody, send: (body: RequestBody) => Promise<Reply>): Promise<Reply> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const first = await send(body);
    if (first.kind !== 'read-page') return first;
    if (!('storeId' in body) || body.kind === 'shutdown' || body.kind === 'read-page')
      throw new Error('Unexpected paged proactive reply');
    const parts: Buffer[] = [];
    let offset = 0;
    let page: Reply = first;
    let restart = false;
    while (page.kind === 'read-page') {
      if (page.readId !== first.readId || page.readVersion !== first.readVersion ||
          page.readSeq !== first.readSeq || page.totalBytes !== first.totalBytes ||
          page.offset !== offset || page.totalBytes > maxReadBytes)
        throw new Error('Inconsistent proactive query snapshot');
      const bytes = Buffer.from(page.data, 'base64');
      if (!bytes.length || bytes.length > readPageBytes || offset + bytes.length > page.totalBytes)
        throw new Error('Invalid proactive query page');
      parts.push(bytes);
      offset += bytes.length;
      if (page.nextOffset === undefined) {
        const all = Buffer.concat(parts, offset);
        if (offset !== page.totalBytes || createHash('sha256').update(all).digest('hex') !== page.readVersion)
          throw new Error('Incomplete proactive query snapshot');
        const result = replySchema.parse(JSON.parse(all.toString('utf8')));
        if (result.kind === 'read-page' || result.correlationId !== first.correlationId)
          throw new Error('Unexpected proactive query content');
        return result;
      }
      if (page.nextOffset !== offset || offset >= page.totalBytes) throw new Error('Invalid proactive query cursor');
      page = await send({ kind: 'read-page', storeId: body.storeId, readId: page.readId,
        readVersion: page.readVersion, offset });
      if (page.kind === 'rejected' && page.code === 'stale') { restart = true; break; }
      if (page.kind !== 'read-page') return page;
    }
    if (!restart) throw new Error('Proactive query interrupted');
    // The old snapshot is discarded. Never combine old and new pages.
  }
  throw new Error('Proactive query changed while reading; retry later');
}
