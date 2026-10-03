import { CodexAppServerClient } from '../../src/runtime/codex/app-server-client.js';
import { until } from './desktop-gui-cdp.js';

/** 启动探测的短期限不能成为后续 GUI 恢复 RPC 的期限。 */
export async function connectDesktopGuiBackend(endpoint: string): Promise<CodexAppServerClient> {
  await until(async () => {
    try {
      const probe = await CodexAppServerClient.connect(endpoint, 500);
      probe.close();
      return true;
    } catch { return false; }
  }, '保存的 LaunchAgent 启动');
  // 使用产品默认连接与请求预算，避免验收专用期限掩盖生产恢复问题。
  // 该连接上的 RPC 只发一次，超时仍失败，不用重复 resume 掩盖丢失的响应。
  return CodexAppServerClient.connect(endpoint);
}
