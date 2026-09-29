/**
 * Render an unknown thrown or wire value for a message. Errors give their
 * message and plain objects their JSON form (never "[object Object]").
 */
export function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value) ?? "[unserializable value]";
    } catch {
      return "[unserializable value]";
    }
  }
  return String(value as number | boolean | bigint | symbol | undefined);
}
