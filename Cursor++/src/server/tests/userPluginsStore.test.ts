import type { ConnectRouter } from '@connectrpc/connect'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@connectrpc/connect'
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify'
import { createConnectTransport } from '@connectrpc/connect-node'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardService } from '../gen/aiserver_v1_pb'

/**
 * GetEffectiveUserPlugins 透传回归测试。
 *
 * 背景: BYOK 曾对该端点返回空对象 {}, Cursor 认为用户没有安装任何插件,
 * 已安装的插件 (如 pstack) 的 skills/agents/automations 全部失效。
 * 修复: 透传客户端请求 (带认证头) 到官方 api2.cursor.sh, 失败时回落
 * ~/.ccursor/user-plugins.json, 与 GetManagedSkills 的 fetchManagedSkills 同模式。
 *
 * Seam: connect-fastify 真路由 + connect-node 真客户端打到 DashboardService,
 * 官方上游用 vi.stubGlobal('fetch') 拦截 — 既验证 handler 接线, 也验证 store 逻辑。
 */

// Mock paths.ts 让 store 指向临时目录, 避免污染 ~/.ccursor/user-plugins.json
let tmpDir: string
vi.mock('../config/paths', async () => {
  return {
    getManagedSkillsFilePath: () => join(tmpDir, 'managed-skills.json'),
    getUserPluginsFilePath: () => join(tmpDir, 'user-plugins.json'),
  }
})

async function loadServerModule() {
  // 动态 import 保证 vi.mock 就位; 每个测试文件重新加载也重置 store 的模块级缓存
  return await import('../services/account/DashboardService')
}

const UPSTREAM_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetEffectiveUserPlugins'

let app: ReturnType<typeof Fastify> | null = null
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'byok-plugins-'))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // 模块级 TTL 缓存 (60s) 会跨用例存活 — 每用例前清空, 保证隔离
  const store = await import('../config/userPluginsStore')
  store.resetUserPluginsCacheForTests()
})

afterEach(async () => {
  if (app) {
    await app.close()
    app = null
  }
  vi.unstubAllGlobals()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function startDashboardServer(): Promise<string> {
  const mod = await loadServerModule()
  app = Fastify()
  await app.register(fastifyConnectPlugin, { routes: (router: ConnectRouter) => mod.default(router) })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const addr = app.server.address() as AddressInfo
  return `http://127.0.0.1:${addr.port}`
}

async function getEffectiveUserPlugins(baseUrl: string): Promise<any> {
  const transport = createConnectTransport({ baseUrl, httpVersion: '1.1' })
  const client = createClient(DashboardService, transport)
  return await client.getEffectiveUserPlugins({}, { headers: { authorization: 'Bearer test-token' } })
}

describe('dashboardService/GetEffectiveUserPlugins passthrough', () => {
  it('forwards the request to the official API and returns its plugins', async () => {
    // 字段名须匹配 proto schema: EffectivePlugin.plugin → Plugin.name
    const officialResponse = { plugins: [{ plugin: { name: 'pstack' }, isEnabled: true }], marketplaces: [] }
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => officialResponse })

    const baseUrl = await startDashboardServer()
    const res = await getEffectiveUserPlugins(baseUrl)

    // 响应来自官方
    expect(res.plugins?.[0]?.plugin?.name).toBe('pstack')
    expect(res.plugins?.[0]?.isEnabled).toBe(true)

    // 透传调用: 正确的 URL + 认证头转发
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(UPSTREAM_URL)
    expect(init.headers.authorization).toBe('Bearer test-token')
    expect(init.headers['connect-protocol-version']).toBe('1')

    // 成功响应持久化到 user-plugins.json 供离线 fallback
    const persisted = JSON.parse(readFileSync(join(tmpDir, 'user-plugins.json'), 'utf-8'))
    expect(persisted.plugins[0].plugin.name).toBe('pstack')
  })

  it('falls back to the local cache when the official API is unreachable', async () => {
    writeFileSync(join(tmpDir, 'user-plugins.json'), JSON.stringify({ plugins: [{ plugin: { name: 'cached-plugin' } }] }))
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    const baseUrl = await startDashboardServer()
    const res = await getEffectiveUserPlugins(baseUrl)

    expect(res.plugins?.[0]?.plugin?.name).toBe('cached-plugin')
  })

  it('returns an empty object when upstream fails and no local cache exists', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    const baseUrl = await startDashboardServer()
    const res = await getEffectiveUserPlugins(baseUrl)

    // handler 返回 {} → proto3 repeated 字段在客户端解码为空数组
    expect(res.plugins).toEqual([])
  })

  it('serves the cached response within the TTL without hitting the official API again', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ plugins: [{ plugin: { name: 'pstack' } }] }) })

    const baseUrl = await startDashboardServer()
    await getEffectiveUserPlugins(baseUrl)
    await getEffectiveUserPlugins(baseUrl)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
