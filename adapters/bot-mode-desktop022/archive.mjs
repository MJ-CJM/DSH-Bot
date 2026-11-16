import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Keep every packed/unpacked/link entry, changing only explicitly reviewed files. */
export function openArchive(bytes) {
  const headerSize = bytes.readUInt32LE(4);
  const table = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)));
  const files = [];
  const walk = (node, prefix = '') => {
    for (const [name, row] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (row.files) walk(row, path);
      else if (row.offset !== undefined) files.push({ path, row, offset: Number(row.offset), size: row.size });
    }
  };
  walk(table); files.sort((a, b) => a.offset - b.offset);
  const read = path => {
    const file = files.find(item => item.path === path); assert.ok(file, `Packed file missing: ${path}`);
    return bytes.subarray(8 + headerSize + file.offset, 8 + headerSize + file.offset + file.size);
  };
  return { table, files, read };
}
export function rewriteArchive(bytes, overrides) {
  const archive = openArchive(bytes), payload = [];
  for (const path of overrides.keys()) assert.ok(archive.files.some(file => file.path === path), `Unknown override: ${path}`);
  let offset = 0;
  for (const file of archive.files) {
    const data = overrides.has(file.path) ? Buffer.from(overrides.get(file.path)) : archive.read(file.path);
    file.row.offset = String(offset); file.row.size = data.length;
    if (overrides.has(file.path) && file.row.integrity) {
      const blockSize = file.row.integrity.blockSize, blocks = [];
      assert.ok(blockSize > 0);
      for (let i = 0; i < data.length; i += blockSize) blocks.push(sha256(data.subarray(i, i + blockSize)));
      file.row.integrity = { algorithm: 'SHA256', hash: sha256(data), blockSize, blocks };
    }
    payload.push(data); offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(archive.table));
  const picklePayload = Math.ceil((4 + json.length) / 4) * 4;
  const header = Buffer.alloc(4 + picklePayload);
  header.writeUInt32LE(picklePayload, 0); header.writeUInt32LE(json.length, 4); json.copy(header, 8);
  const prefix = Buffer.alloc(8); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(header.length, 4);
  const result = Buffer.concat([prefix, header, ...payload]);
  const rewritten = openArchive(result);
  for (const file of archive.files) assert.deepEqual(rewritten.read(file.path), overrides.has(file.path) ? Buffer.from(overrides.get(file.path)) : archive.read(file.path));
  return { bytes: result, headerSha256: sha256(json), changed: [...overrides.keys()] };
}
