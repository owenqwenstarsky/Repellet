import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { db } from './db.js';
import { users, sessions, projects, members } from './schema.js';
import { hasProjectCapability, type ProjectCapability } from '@repellet/shared';
import { workspaceContext } from './workspaceContext.js';
export const SESSION_COOKIE = 'repellet_session';
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function encrypt(value: string, key = config.encryptionKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function decrypt(value: string, key = config.encryptionKey) {
  const data = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
export function tokenMatches(provided: string, expected: string) {
  const a = Buffer.from(tokenHash(provided)),
    b = Buffer.from(tokenHash(expected));
  return timingSafeEqual(a, b);
}
export const hashPassword = (password: string) =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);
export type AuthUser = typeof users.$inferSelect;
export const publicUser = (user: AuthUser) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  isOwner: user.isOwner,
  enabled: user.enabled,
  createdAt: user.createdAt.toISOString(),
});
export async function userForToken(token: string | undefined) {
  if (!token) return null;
  const [record] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash(token)),
        gt(sessions.expiresAt, new Date()),
        eq(users.enabled, true),
      ),
    );
  return record?.user || null;
}
export async function requireUser(req: FastifyRequest) {
  const user = await userForToken(req.cookies[SESSION_COOKIE]);
  if (!user) throw Object.assign(new Error('Sign in to continue'), { statusCode: 401 });
  return user;
}
export async function requireOwner(req: FastifyRequest) {
  const user = await requireUser(req);
  if (!user.isOwner)
    throw Object.assign(new Error('Site owner access required'), { statusCode: 403 });
  return user;
}
export async function projectAccess(
  user: AuthUser,
  id: string,
  mode: Exclude<ProjectCapability, 'agent.execute'> = 'view',
) {
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  let role: 'owner' | 'editor' | 'viewer';
  if (project.ownerId === user.id) role = 'owner';
  else {
    const [membership] = await db
      .select()
      .from(members)
      .where(and(eq(members.projectId, id), eq(members.userId, user.id)));
    if (!membership) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    role = membership.role;
  }
  if (!hasProjectCapability(role, mode))
    throw Object.assign(new Error('Insufficient project permissions'), { statusCode: 403 });
  const context = workspaceContext.getStore();
  if (context) {
    context.projectId = id;
    context.actor = { id: user.id, name: user.displayName, role };
  }
  return { ...project, role };
}
export async function issueSession(user: AuthUser, reply: FastifyReply) {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    tokenHash: tokenHash(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.publicUrl.startsWith('https:'),
    maxAge: 7 * 86400,
  });
  return publicUser(user);
}

/** Agent ownership deliberately excludes site-administrator privileges. */
export async function projectAgentAccess(user: AuthUser, id: string) {
  const [currentUser] = await db
    .select({ enabled: users.enabled })
    .from(users)
    .where(eq(users.id, user.id));
  if (!currentUser?.enabled)
    throw Object.assign(new Error('Sign in to continue'), { statusCode: 401 });
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project || project.ownerId !== user.id)
    throw Object.assign(new Error('Project owner access required for agents'), { statusCode: 403 });
  if (project.state !== 'running')
    throw Object.assign(new Error('Start the workspace to load agent conversations'), {
      statusCode: 409,
    });
  return project;
}
