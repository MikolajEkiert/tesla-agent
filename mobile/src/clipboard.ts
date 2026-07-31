import { Platform } from "react-native";

/**
 * Copy text, wherever the app happens to be running.
 *
 * The browser's own API is tried first because that is the platform this ships
 * on, and it is the only one of the two that is not deprecated. It also refuses
 * outside a secure context, which a phone on a local IP address may well be —
 * hence the fallback, and hence the boolean: the caller shows "copied" only if
 * something was.
 */
export async function copyText(text: string): Promise<boolean> {
  if (Platform.OS === "web") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyViaHiddenField(text);
    }
  }
  try {
    // Deprecated in core but still present, and pulling in a native module for
    // one call is not worth it here.
    const { Clipboard } = require("react-native");
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}

/** The pre-Clipboard-API trick, for an insecure origin (http://192.168.x.x)
 *  where navigator.clipboard simply is not there. */
function copyViaHiddenField(text: string): boolean {
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(field);
    return ok;
  } catch {
    return false;
  }
}
