const documents = new Map<string, () => Promise<void>>();
export function registerDocumentSave(project: string, path: string, flush: () => Promise<void>) {
  const key = `${project}:${path}`;
  documents.set(key, flush);
  return () => {
    if (documents.get(key) === flush) documents.delete(key);
  };
}
export async function flushOpenDocuments(project: string) {
  await Promise.all(
    [...documents].filter(([key]) => key.startsWith(project + ':')).map(([, flush]) => flush()),
  );
}
