import os from 'node:os';
import path from 'node:path';

// 配置相关的全局路径常量和用户路径展开工具。
// legacy config 输入文件路径已迁到 migrations/legacy/paths.ts，避免运行时继续依赖旧存储。

export const DEFAULT_CODELARK_HOME = path.join(os.homedir(), '.codelark');
export const DEFAULT_WORKSPACE_ROOT = os.homedir();

export const CODELARK_HOME = process.env.CODELARK_HOME || DEFAULT_CODELARK_HOME;

export function expandHomePath(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
