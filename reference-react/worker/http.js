export class PublicError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readRequestJson(request, maxBytes = 65536) {
  const tooLarge = () => new PublicError(413, "body_too_large", "请求内容过大，请缩小后重试。");
  if (Number(request.headers.get("content-length")) > maxBytes) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError(400, "invalid_json", "请提供有效的请求内容。");
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new PublicError(400, "invalid_json", "请求格式无效，请刷新后重试。"); }
}

export function publicFailure(error) {
  const requestId = crypto.randomUUID();
  const known = error instanceof PublicError;
  // Log categories only: upstream messages can contain URLs, keys or private input.
  console.error(JSON.stringify({ requestId, category: known ? error.code : "internal_error" }));
  return Response.json({ error: known ? error.code : "request_failed", requestId,
    message: known ? error.message : "服务暂时无法完成请求，请稍后重试。" },
  { status: known ? error.status : 500, headers: { "cache-control": "no-store" } });
}
