import { z } from 'zod';
import type { AppServerPendingRequest } from '../../runtime/codex/app-server-lifecycle.js';

const specialPath = z.object({ kind: z.enum(['root', 'minimal', 'project_roots', 'current_working_directory', 'tmpdir', 'slash_tmp', 'unknown']), path: z.string().optional(), subpath: z.string().nullish() }).strict();
const filePath = z.union([
  z.object({ type: z.literal('path'), path: z.string() }).strict(),
  z.object({ type: z.literal('glob_pattern'), pattern: z.string() }).strict(),
  z.object({ type: z.literal('special'), value: specialPath }).strict(),
]);
const permissionsSchema = z.object({
  network: z.object({ enabled: z.boolean().nullish() }).strict().nullish(),
  fileSystem: z.object({
    read: z.array(z.string()).nullish(), write: z.array(z.string()).nullish(),
    globScanMaxDepth: z.number().int().positive().optional(),
    entries: z.array(z.object({ path: filePath, access: z.enum(['read', 'write', 'deny']) }).strict()).optional(),
  }).strict().nullish(),
}).strict();

export function requestedPermissions(value: unknown) {
  const result = permissionsSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function describePermissions(value: unknown): string[] {
  const permissions = requestedPermissions(value);
  if (!permissions) return ['无法识别完整权限范围，请在 Codex 客户端核对；这里仍可拒绝请求。'];
  const lines: string[] = [];
  if (permissions.network?.enabled != null) lines.push(`网络访问：${permissions.network.enabled ? '允许' : '关闭'}`);
  for (const [key, label] of [['read', '允许读取'], ['write', '允许写入']] as const) {
    for (const file of permissions.fileSystem?.[key] || []) lines.push(`${label}：${file}`);
  }
  const specialLabels: Record<string, string> = { root: '所有路径', minimal: '基础系统路径', project_roots: '项目目录', current_working_directory: '项目目录', tmpdir: '临时目录', slash_tmp: '/tmp' };
  for (const entry of permissions.fileSystem?.entries || []) {
    const p = entry.path;
    const target = p.type === 'path' ? p.path : p.type === 'glob_pattern' ? `匹配 ${p.pattern}`
      : `${specialLabels[p.value.kind] || p.value.path || p.value.kind}${p.value.subpath ? `/${p.value.subpath}` : ''}`;
    lines.push(`${{ read: '允许读取', write: '允许写入', deny: '禁止访问' }[entry.access]}：${target}`);
  }
  if (permissions.fileSystem?.globScanMaxDepth) lines.push(`目录匹配深度：${permissions.fileSystem.globScanMaxDepth}`);
  return [...new Set(lines)];
}

export interface RequestQuestion {
  id: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  schema?: Record<string, any>;
  optional?: boolean;
}

export function isMcpForm(request: AppServerPendingRequest): boolean {
  return request.method === 'mcpServer/elicitation/request' && ['form', 'openai/form', 'openaiForm'].includes(String(request.params.mode));
}

export function mcpSchema(request: AppServerPendingRequest): z.ZodType | undefined {
  if (!isMcpForm(request)) return undefined;
  const schema = request.params.requestedSchema as Record<string, any> | undefined;
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return undefined;
  try { return z.fromJSONSchema(schema); } catch { return undefined; }
}

export function questionsOf(request: AppServerPendingRequest): RequestQuestion[] {
  if (request.method === 'item/tool/requestUserInput' && Array.isArray(request.params.questions)) {
    return request.params.questions.filter((q): q is RequestQuestion => Boolean(q && typeof q === 'object'
      && typeof q.id === 'string' && typeof q.question === 'string')).map((q) => ({
        id: q.id, question: q.question,
        options: Array.isArray(q.options) ? q.options.filter((o) => o && typeof o.label === 'string') : [],
      }));
  }
  if (!mcpSchema(request)) return [];
  const schema = request.params.requestedSchema as Record<string, any>;
  return Object.entries(schema.properties).map(([id, value]) => {
    const property = value as Record<string, any>;
    const values = property.enum || (property.oneOf?.every((v: any) => typeof v.const === 'string') ? property.oneOf.map((v: any) => v.const) : undefined);
    return {
      id, schema: property, optional: !schema.required?.includes(id),
      question: [property.title || id, property.description,
        property.type === 'array' ? '可发送多个值，以换行分隔。' : property.type === 'number' || property.type === 'integer' ? '请输入数字。' : ''].filter(Boolean).join('\n'),
      options: property.type === 'boolean' ? [{ label: '是' }, { label: '否' }]
        : Array.isArray(values) ? values.map((v: unknown) => ({ label: String(v) })) : [],
    };
  });
}

export function parseMcpAnswer(question: RequestQuestion, text: string): unknown {
  const schema = question.schema!;
  const value = schema.type === 'number' || schema.type === 'integer' ? (text.trim() ? Number(text) : NaN)
    : schema.type === 'boolean' ? (['是', 'true'].includes(text) ? true : ['否', 'false'].includes(text) ? false : text)
      : schema.type === 'array' ? (text.trim().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean))
        : schema.type === 'object' ? JSON.parse(text) : text;
  return z.fromJSONSchema(schema).parse(value);
}
