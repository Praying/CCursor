/**
 * aiserver.v1.BidiService — Bidi 辅助服务
 *
 * 1 方法:
 *   - BidiAppend (unary) — 向 bidi 流追加消息
 *     SSE 降级模式下，客户端通过此方法发送 AgentClientMessage，
 *     data 字段包含 base64 编码的序列化 protobuf，requestId 关联到 RunSSE 流。
 *
 * Transport: backendUrl (api2.cursor.sh)
 */
import type { ConnectRouter } from '@connectrpc/connect';
import { BidiService } from '../../gen/aiserver_v1_pb';
import { appendMessage } from '../../handlers/agent/session';
import { logger } from '../../logger';

export default (router: ConnectRouter) => {
    router.service(BidiService, {
        bidiAppend: async (req) => {
            const requestId = req.requestId?.requestId;
            // BidiAppend 消息体有两种互斥编码:
            //   data (field 1)       — hex string, 旧客户端
            //   dataBinary (field 4) — 原始 bytes, Cursor "bidi_append_fix" gate
            //                          (binaryEncoding) 开启时, 3.30 默认灰度。
            // 只读 data 时 dataBinary 消息被静默丢弃 (仍 ACK 200), RunSSE 等待
            // 首条消息 30s 超时, 客户端看到 "RunSSE waited for the first
            // BidiAppend message but none arrived"。两条编码统一转成 hex 交给
            // appendMessage (其内部 hex → bytes → proto decode)。
            let data = req.data;
            const isBinary = (!data || data.length === 0) && req.dataBinary.length > 0;
            if (isBinary) {
                data = Buffer.from(req.dataBinary).toString('hex');
            }
            if (requestId && data) {
                logger.info({ requestId, dataLen: data.length, seqno: Number(req.appendSeqno), binary: isBinary }, '[SVC] BidiAppend');
                appendMessage(requestId, data);
            } else {
                logger.warn({ hasRequestId: !!requestId, hasData: !!data }, '[SVC] BidiAppend missing fields');
            }
            return {};
        },
    });
};
