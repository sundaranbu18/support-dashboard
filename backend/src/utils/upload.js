import multer from 'multer';
import { callFiles } from '../db/index.js';

// Files are buffered in memory and then stored in Convex file storage.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

// Uploads one buffer to Convex storage under a unique name; returns the public /uploads path.
export async function storeFile({ originalname, mimetype, buffer, size }) {
  const safe = String(originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
  const uploadUrl = await callFiles('mutation', 'generateUploadUrl');
  const res = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': mimetype || 'application/octet-stream' }, body: buffer });
  if (!res.ok) throw new Error(`File upload failed (${res.status})`);
  const { storageId } = await res.json();
  await callFiles('mutation', 'save', { name, storageId, contentType: mimetype || null, size: size ?? buffer.length });
  return `/uploads/${name}`;
}

// Stores a multer file and returns the attachment columns for it.
export async function fileRecord(file) {
  return {
    file_name: file.originalname,
    content_type: file.mimetype,
    size: file.size,
    path: await storeFile(file),
  };
}

// GET /uploads/:name -> streams the file from Convex storage.
export async function serveUpload(req, res, next) {
  try {
    const info = await callFiles('query', 'url', { name: req.params.name });
    if (!info?.url) return res.status(404).json({ error: 'File not found' });
    const upstream = await fetch(info.url);
    if (!upstream.ok) return res.status(502).json({ error: 'File storage unavailable' });
    res.setHeader('Content-Type', info.content_type || upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    next(err);
  }
}
