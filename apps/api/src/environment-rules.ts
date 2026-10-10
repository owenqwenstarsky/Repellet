import { environmentSchema, type EnvironmentOperation } from '@repellet/shared';

export const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
export function applyEnvironmentOperation(
  variables: Record<string, string>,
  operation: EnvironmentOperation,
  managedName?: string,
) {
  const next = { ...variables };
  const exists = Object.hasOwn(next, operation.name);
  if (operation.operation === 'create') {
    if (exists) throw conflict('Variable already exists');
    Object.defineProperty(next, operation.name, {
      value: operation.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    if (!exists) throw Object.assign(new Error('Variable does not exist'), { statusCode: 404 });
    if (operation.name === managedName && operation.operation !== 'rename')
      throw conflict('This variable is managed by the database. Rename it or delete the database.');
    if (operation.operation === 'update') next[operation.name] = operation.value;
    if (operation.operation === 'delete') delete next[operation.name];
    if (operation.operation === 'rename') {
      if (operation.newName !== operation.name && Object.hasOwn(next, operation.newName))
        throw conflict('The new variable name already exists');
      const value = next[operation.name]!;
      delete next[operation.name];
      Object.defineProperty(next, operation.newName, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return environmentSchema.parse(next);
}
export function assertManagedVariable(
  current: Record<string, string>,
  next: Record<string, string>,
  managedName?: string,
  newName = managedName,
) {
  if (!managedName) return;
  if (!newName || !Object.hasOwn(next, newName) || next[newName] !== current[managedName])
    throw conflict(
      'The database connection value cannot be edited or removed. Delete the database first.',
    );
  if (
    newName !== managedName &&
    (Object.hasOwn(current, newName) || Object.hasOwn(next, managedName))
  )
    throw conflict('Choose an unused name for the database variable');
}
