/**
 * user-plugins.json — 官方 GetEffectiveUserPlugins 的本地缓存
 *
 * 与 managedSkillsStore 同模式: 透传客户端请求到官方, 成功 → 缓存到内存 +
 * 持久化到 ~/.ccursor/user-plugins.json; 失败 → 回落本地文件。
 *
 * 历史: 此前端死为空响应 {}, Cursor 认为用户没有安装任何插件,
 * pstack 等用户插件的 skills/agents/automations 全部失效 (Issue: BYOK 开启后
 * 插件不可用)。
 *
 * 但透传方案对 agent-host 不成立: agent-host 有一条**不带 authorization** 的
 * GetEffectiveUserPlugins 调用路径, 请求被 HTTP/1.1 router 转到本服务器后,
 * 透传官方必 401 → 空列表; 而它自己直连官方的另一条路径拿得到真实列表
 * (5 plugins 含 pstack)。空结果会覆盖真实结果, 插件依旧失效。
 *
 * 最终方案: **不拦截** (BYOK_REDIRECT 已移除该端点, 见 defaults.ts), 两条
 * 路径都直连官方。本 handler 仅在 routes.json 被手动加回该端点时作为兜底 ——
 * 至少透传 + 本地缓存, 不再返回空。
 */
import { logger } from '../logger'
import { readJsonOrNull, writeJsonAtomic } from './atomic'
import { buildForwardHeaders } from './managedSkillsStore'
import { getUserPluginsFilePath } from './paths'

const OFFICIAL_BASE = 'https://api2.cursor.sh'
const ENDPOINT = '/aiserver.v1.DashboardService/GetEffectiveUserPlugins'
// 比 managedSkills (10min) 短: 插件安装/启停后最多 1 分钟生效,
// 避免装完插件 "看起来没装上"。
const CACHE_TTL_MS = 60 * 1000

interface CacheEntry {
  expiresAt: number
  data: Record<string, unknown>
}

let cache: CacheEntry | null = null

export async function fetchEffectiveUserPlugins(
  clientHeaders: Headers,
  requestBody = '{}',
): Promise<Record<string, unknown>> {
  const now = Date.now()
  if (cache && cache.expiresAt > now)
    return cache.data

  try {
    const res = await fetch(`${OFFICIAL_BASE}${ENDPOINT}`, {
      method: 'POST',
      headers: buildForwardHeaders(clientHeaders),
      body: requestBody,
    })

    if (!res.ok) {
      logger.warn({ status: res.status }, '[PLUGINS] upstream GetEffectiveUserPlugins failed')
      return fallback()
    }

    const data = await res.json() as Record<string, unknown>
    cache = { expiresAt: now + CACHE_TTL_MS, data }
    const count = Array.isArray(data.plugins) ? data.plugins.length : 0
    logger.info({ count }, '[PLUGINS] upstream GetEffectiveUserPlugins fetched')
    persistLocal(data)
    return data
  }
  catch (err) {
    logger.warn({ err: (err as Error).message }, '[PLUGINS] upstream GetEffectiveUserPlugins error')
    return fallback()
  }
}

function persistLocal(data: Record<string, unknown>): void {
  try {
    writeJsonAtomic(getUserPluginsFilePath(), data)
  }
  catch (err) {
    logger.debug({ err: (err as Error).message }, '[PLUGINS] persist to local failed (non-critical)')
  }
}

// 与 managedSkillsStore 不同: fallback 不设 TTL — 网络恢复后的下一次请求立即重试透传
function fallback(): Record<string, unknown> {
  if (cache)
    return cache.data
  const local = readJsonOrNull<Record<string, unknown>>(getUserPluginsFilePath())
  if (local) {
    const count = Array.isArray(local.plugins) ? local.plugins.length : 0
    logger.info({ count }, '[PLUGINS] loaded user plugins from local cache')
    return local
  }
  return {}
}

/** 测试隔离: 清空模块级缓存 */
export function resetUserPluginsCacheForTests(): void {
  cache = null
}
