export type Page = 'projects' | 'github' | 'admin' | 'workspace';
export type Route = { page: Page; project: string };
export function parseRoute(pathname = location.pathname): Route {
  const match = pathname.match(/^\/projects\/([a-f0-9-]+)$/);
  if (match) return { page: 'workspace', project: match[1]! };
  if (pathname === '/admin') return { page: 'admin', project: '' };
  if (pathname === '/github') return { page: 'github', project: '' };
  return { page: 'projects', project: '' };
}
export function pathFor(page: Page, project = '') {
  return page === 'workspace' ? `/projects/${project}` : page === 'projects' ? '/' : `/${page}`;
}
