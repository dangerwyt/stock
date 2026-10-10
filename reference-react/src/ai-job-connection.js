// Keep the initiating response open while the existing job-status endpoint supplies progress.
export async function readAiJobConnection(response) {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    return { accepted: await response.json(), connection: null };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("会诊连接在任务确认前中断，请重试。");
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  const accepted = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
  const connection = { closed: false, failed: false };
  void (async () => {
    try { while (!(await reader.read()).done) { /* Drain keep-alive frames without buffering. */ } }
    catch { connection.failed = true; }
    finally { connection.closed = true; reader.releaseLock(); }
  })();
  return { accepted, connection };
}
