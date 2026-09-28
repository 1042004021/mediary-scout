/** Where a URL the app window wants to open belongs: the app's own server ("app"), the outside
 *  world over http(s) ("external", opened in the system browser), or neither ("other", never opened). */
export function linkTarget(url: string, serverOrigin: string): "app" | "external" | "other" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "other";
  return parsed.origin === serverOrigin ? "app" : "external";
}
