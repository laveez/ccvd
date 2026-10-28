const SCHEME = /^[a-z][a-z\d+.-]*:/i;

export function parseBase(input: string): URL {
  const candidate = SCHEME.test(input) && !/^[^/:]+:\d+(\/|$)/.test(input) ? input : `http://${input}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Not a valid address: ${input}`);
  }
  assertWeb(url, input);
  return url;
}

export function resolvePath(base: URL, path: string): URL {
  const url = new URL(path, base);
  assertWeb(url, path);
  return url;
}

export function mapUrl(url: string, from: URL, to: URL): string {
  const target = new URL(url);
  if (target.origin !== from.origin) return url;
  const fromPrefix = directoryOf(from.pathname);
  const toPrefix = directoryOf(to.pathname);
  const pathname = target.pathname.startsWith(fromPrefix)
    ? toPrefix + target.pathname.slice(fromPrefix.length)
    : target.pathname;
  return `${to.origin}${pathname}${target.search}${target.hash}`;
}

export function displayPath(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

export function pathSlug(url: URL, base: URL): string {
  const prefix = directoryOf(base.pathname);
  const relative = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  const slug = safeDecode(`${relative}${url.search}`)
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'index';
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function directoryOf(pathname: string): string {
  return pathname.slice(0, pathname.lastIndexOf('/') + 1);
}

function assertWeb(url: URL, input: string): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https addresses are supported: ${input}`);
  }
}
