/**
 * Read a chosen or dropped file as base64 (no data: prefix), the shape
 * POST /api/documents takes. Browser-safe and directly testable.
 */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read that file"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolvePromise(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
