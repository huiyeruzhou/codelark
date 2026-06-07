// legacy config.env 解析器：只供 v1 migration 读取旧输入，不参与 v2 运行时配置加载。

export function parseLegacyEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const source = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const eqIdx = source.indexOf('=');
    if (eqIdx === -1) continue;
    const key = source.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = source.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}
