// One API process owns every live document. All REST and WebSocket mutations
// join this queue before taking the database row lock.
const queues = new Map<string, Promise<void>>();
export async function acquireProject(projectId: string): Promise<() => void> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => current);
  queues.set(projectId, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    if (queues.get(projectId) === tail) queues.delete(projectId);
  };
}
export async function withProject<T>(
  projectId: string,
  action: () => Promise<T>,
): Promise<T> {
  const release = await acquireProject(projectId);
  try {
    return await action();
  } finally {
    release();
  }
}
