export async function consumeNdjsonObjects(
  response: Response,
  onObject: (value: Record<string, unknown>) => boolean | void | Promise<boolean | void>,
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
      const { value, done } = await reader.read();
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
