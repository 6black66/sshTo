const fs = require("node:fs");
const { TextDecoder } = require("node:util");
const PREVIEW_LIMIT = 1024 * 1024;
const call = (object, method, ...args) =>
  new Promise((resolve, reject) =>
    object[method](...args, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );

class PreviewReader {
  constructor(getSftp, timeout = 30000) {
    this.getSftp = getSftp;
    this.timeout = timeout;
    this.requests = new Map();
  }
  read(requestId, sessionId, filePath) {
    if (
      typeof requestId !== "string" ||
      !requestId ||
      requestId.length > 100 ||
      this.requests.has(requestId)
    )
      return Promise.reject(Error("预览请求无效"));
    if (
      (sessionId !== null && typeof sessionId !== "string") ||
      typeof filePath !== "string" ||
      !filePath ||
      filePath.includes("\0")
    )
      return Promise.reject(Error("预览路径或会话无效"));
    return new Promise((resolve, reject) => {
      let settled = false,
        stream;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.requests.delete(requestId);
        stream?.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () => finish(Error("读取超时（30 秒），请稍后重试")),
        this.timeout,
      );
      this.requests.set(requestId, {
        sessionId,
        cancel: (reason) => finish(Error(reason || "已取消预览")),
      });
      (async () => {
        const ftp = sessionId === null ? null : this.getSftp(sessionId);
        const stat = ftp
          ? await call(ftp, "stat", filePath)
          : await fs.promises.stat(filePath);
        if (settled) return;
        if (!stat.isFile()) throw Error("仅支持预览普通文件");
        const options = {
          start: 0,
          end: PREVIEW_LIMIT,
          highWaterMark: 64 * 1024,
        };
        stream = ftp
          ? ftp.createReadStream(filePath, options)
          : fs.createReadStream(filePath, {
              ...options,
              flags: fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
            });
        const chunks = [];
        let length = 0;
        stream.on("error", (error) => finish(error));
        stream.on("data", (chunk) => {
          if (settled) return;
          const remaining = PREVIEW_LIMIT + 1 - length;
          if (remaining > 0) {
            const bytes = chunk.subarray(0, remaining);
            chunks.push(bytes);
            length += bytes.length;
          }
          if (length >= PREVIEW_LIMIT + 1) complete();
        });
        const complete = () => {
          if (settled) return;
          const truncated = length > PREVIEW_LIMIT;
          const bytes = Buffer.concat(chunks).subarray(0, PREVIEW_LIMIT);
          try {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            // A truncated final UTF-8 codepoint is left out, rather than shown as a replacement character.
            const text = decoder.decode(bytes, { stream: truncated });
            if (/[\x00-\x08\x0B\x0E-\x1A\x1C-\x1F\x7F]/.test(text))
              throw Error("binary");
            finish(null, { text, truncated, bytesRead: bytes.length });
          } catch {
            finish(Error("暂不支持预览二进制或非 UTF-8 文件，请下载后查看"));
          }
        };
        stream.on("end", complete);
        stream.on("close", () => {
          if (!settled) finish(Error("文件读取已中断"));
        });
      })().catch((error) => finish(error));
    });
  }
  cancel(requestId, reason) {
    this.requests.get(requestId)?.cancel(reason);
  }
  cancelSession(sessionId) {
    for (const request of [...this.requests.values()])
      if (request.sessionId === sessionId)
        request.cancel("连接已断开，无法读取文件");
  }
  cancelAll() {
    for (const request of [...this.requests.values()]) request.cancel();
  }
}
module.exports = { PreviewReader, PREVIEW_LIMIT };
