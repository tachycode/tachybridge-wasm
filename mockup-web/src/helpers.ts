export function parseJsonInput(input: string, fieldName: string): Record<string, unknown> {
  const text = input.trim();
  if (!text) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${fieldName}: invalid JSON (${String(error)})`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName}: JSON must be an object`);
  }

  return parsed as Record<string, unknown>;
}

export function toLogTime(date = new Date()): string {
  return date.toISOString();
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard API is unavailable in this browser");
}
