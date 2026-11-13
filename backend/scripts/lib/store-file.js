import { callFiles } from '../../src/db/index.js';

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv' };

// Stores a buffer in Convex storage under an exact /uploads/<name> name.
export async function storeFileAs(name, buffer) {
  const contentType = TYPES[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
  const uploadUrl = await callFiles('mutation', 'generateUploadUrl');
  const res = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': contentType }, body: buffer });
  if (!res.ok) throw new Error(`Upload of ${name} failed (${res.status})`);
  const { storageId } = await res.json();
  await callFiles('mutation', 'save', { name, storageId, contentType, size: buffer.length });
}
