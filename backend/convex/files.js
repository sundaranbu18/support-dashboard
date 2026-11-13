// Uploaded attachments / images, stored in Convex file storage.
import { query, mutation } from './_generated/server';
import { v, ConvexError } from 'convex/values';

function checkSecret(secret) {
  const expected = process.env.NEXUS_SERVER_SECRET;
  if (!expected || secret !== expected) throw new ConvexError({ code: 'UNAUTHORIZED', message: 'Invalid server secret' });
}

export const generateUploadUrl = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    checkSecret(secret);
    return ctx.storage.generateUploadUrl();
  },
});

export const save = mutation({
  args: { secret: v.string(), name: v.string(), storageId: v.id('_storage'), contentType: v.optional(v.union(v.null(), v.string())), size: v.number() },
  handler: async (ctx, { secret, name, storageId, contentType, size }) => {
    checkSecret(secret);
    const existing = await ctx.db.query('files').withIndex('by_name', (q) => q.eq('name', name)).unique();
    if (existing) {
      await ctx.storage.delete(existing.storage_id);
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert('files', { name, storage_id: storageId, content_type: contentType ?? null, size, created_at: new Date().toISOString() });
    return name;
  },
});

export const url = query({
  args: { secret: v.string(), name: v.string() },
  handler: async (ctx, { secret, name }) => {
    checkSecret(secret);
    const file = await ctx.db.query('files').withIndex('by_name', (q) => q.eq('name', name)).unique();
    if (!file) return null;
    return { url: await ctx.storage.getUrl(file.storage_id), content_type: file.content_type, size: file.size };
  },
});

export const remove = mutation({
  args: { secret: v.string(), name: v.string() },
  handler: async (ctx, { secret, name }) => {
    checkSecret(secret);
    const file = await ctx.db.query('files').withIndex('by_name', (q) => q.eq('name', name)).unique();
    if (!file) return false;
    await ctx.storage.delete(file.storage_id);
    await ctx.db.delete(file._id);
    return true;
  },
});

export const removeAll = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    checkSecret(secret);
    const files = await ctx.db.query('files').take(500);
    for (const f of files) {
      await ctx.storage.delete(f.storage_id);
      await ctx.db.delete(f._id);
    }
    return files.length;
  },
});
