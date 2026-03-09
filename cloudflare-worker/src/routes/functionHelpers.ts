export function buildInternalRequestUrl(requestUrl: string, pathname: string): string {
  return new URL(pathname, requestUrl).toString();
}

export function parseSseChunk(chunk: string): Record<string, unknown> | null {
  if (!chunk) return null;

  let eventType = "";
  const dataLines: string[] = [];
  for (const rawLine of String(chunk).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!dataLines.length) return null;
  const rawData = dataLines.join("\n");
  if (!rawData || rawData === "[DONE]") return null;

  try {
    const payload = JSON.parse(rawData) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    if (eventType && !record.type) {
      record.type = eventType;
    }
    return record;
  } catch {
    return null;
  }
}
