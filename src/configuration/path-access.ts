// canonical path 访问工具：处理 ConfigPatch/ConfigV2 内部的点分路径读写。
// 这里只支持对象路径，不承载 channels[] 这类字段模板的业务解释。

export function getConfigPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

export function setConfigPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

export function unsetConfigPath(target: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  let current: Record<string, unknown> | undefined = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  delete current[segments[segments.length - 1]!];
}
