import type { ConnectRouter } from '@connectrpc/connect'
/**
 * BidiAppend dataBinary 编码回归测试
 *
 * 背景: Cursor 3.30 agent-host 的 "bidi_append_fix" feature gate (binaryEncoding)
 * 开启后, BidiAppend 改用 dataBinary (field 4, 原始 bytes) 承载 AgentClientMessage,
 * 不再写 data (field 1, hex string)。服务器 BidiService 此前只读 req.data,
 * dataBinary 消息被静默丢弃 (还 ACK 200), RunSSE 等 30s 超时后向客户端抛
 * "RunSSE waited for the first BidiAppend message but none arrived"。
 *
 * Seam: connect-fastify 真实路由 + connect-node 真实客户端 + proto 真实编码,
 * 完整还原客户端 → 服务器的协议路径 (bug 正是发生在 proto 字段读取层)。
 */
import type { AddressInfo } from 'node:net'
import { createClient } from '@connectrpc/connect'
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify'
import { createConnectTransport } from '@connectrpc/connect-node'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidiService } from '../gen/aiserver_v1_pb'
import { appendMessage } from '../handlers/agent/session'
import bidiService from '../services/core/BidiService'

vi.mock('../handlers/agent/session', () => ({
  appendMessage: vi.fn(),
}))

const appendMessageMock = vi.mocked(appendMessage)

let app: ReturnType<typeof Fastify> | null = null

afterEach(async () => {
  if (app) {
    await app.close()
    app = null
  }
  appendMessageMock.mockClear()
})

async function startBidiServer(): Promise<string> {
  app = Fastify()
  await app.register(fastifyConnectPlugin, { routes: (router: ConnectRouter) => bidiService(router) })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const addr = app.server.address() as AddressInfo
  return `http://127.0.0.1:${addr.port}`
}

async function makeBidiClient(baseUrl: string) {
  const transport = createConnectTransport({ baseUrl, httpVersion: '1.1' })
  return createClient(BidiService, transport)
}

// 非空 AgentClientMessage: 手工 protobuf — field 15 (wire type 2) len=4 "test"
const msgBytes = new Uint8Array([0x7A, 0x04, 0x74, 0x65, 0x73, 0x74])
const msgHex = Buffer.from(msgBytes).toString('hex')

describe('aiserver.v1.BidiService/BidiAppend encoding', () => {
  it('consumes dataBinary bytes (bidi_append_fix / binaryEncoding clients)', async () => {
    const baseUrl = await startBidiServer()
    const bidi = await makeBidiClient(baseUrl)

    await bidi.bidiAppend({
      dataBinary: msgBytes,
      requestId: { requestId: 'probe-binary' },
      appendSeqno: 0n,
    })

    expect(appendMessageMock).toHaveBeenCalledTimes(1)
    expect(appendMessageMock).toHaveBeenCalledWith('probe-binary', msgHex)
  })

  it('still consumes the legacy data hex string', async () => {
    const baseUrl = await startBidiServer()
    const bidi = await makeBidiClient(baseUrl)

    await bidi.bidiAppend({
      data: msgHex,
      requestId: { requestId: 'probe-hex' },
      appendSeqno: 0n,
    })

    expect(appendMessageMock).toHaveBeenCalledTimes(1)
    expect(appendMessageMock).toHaveBeenCalledWith('probe-hex', msgHex)
  })

  it('drops messages with neither field and does not call appendMessage', async () => {
    const baseUrl = await startBidiServer()
    const bidi = await makeBidiClient(baseUrl)

    await bidi.bidiAppend({ requestId: { requestId: 'probe-empty' }, appendSeqno: 0n })

    expect(appendMessageMock).not.toHaveBeenCalled()
  })
})
