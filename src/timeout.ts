export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
