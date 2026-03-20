function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs?: number | null,
): Promise<ReadableStreamReadResult<Uint8Array> | { timeout: true }> {
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return reader.read();
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timeout: true } as const), normalizedTimeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function consumeNdjsonObjects(
  response: Response,
  onObject: (value: Record<string, unknown>) => boolean | void | Promise<boolean | void>,
  options: {
    readTimeoutMs?: number | null;
  } = {},
): Promise<void> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stoppedEarly = false;

  const handleLine = async (line: string): Promise<boolean> => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return false;
      }
      return (await onObject(parsed as Record<string, unknown>)) === true;
    } catch {
      return false;
    }
  };

  try {
    while (true) {
      const readResult = await readWithTimeout(reader, options.readTimeoutMs);
      if ("timeout" in readResult) {
        const timeoutMessage = Number.isFinite(Number(options.readTimeoutMs))
          ? `NDJSON stream idle timeout after ${Math.floor(Number(options.readTimeoutMs))}ms`
          : "NDJSON stream idle timeout";
        throw new Error(timeoutMessage);
      }
      const { value, done } = readResult;
      if (done) break;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (await handleLine(line)) {
          stoppedEarly = true;
          return;
        }
        idx = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      await handleLine(buffer);
    }
  } finally {
    if (stoppedEarly) {
      await reader.cancel().catch(() => {
        // ignore cancel failures
      });
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore release failures
    }
  }
}
