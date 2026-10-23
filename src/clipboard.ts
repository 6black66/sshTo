import { api } from "./types";
export function installClipboardSupport(onError: (error: unknown) => void) {
  const terminalTarget = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(".terminal");
  const keydown = (event: KeyboardEvent) => {
    if (
      terminalTarget(event.target) ||
      event.defaultPrevented ||
      !event.ctrlKey ||
      !event.shiftKey ||
      event.altKey ||
      event.metaKey
    )
      return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "v") return;
    event.preventDefault();
    if (!event.repeat)
      void api("clipboard:edit", key === "c" ? "copy" : "paste").catch(onError);
  };
  const contextmenu = (event: MouseEvent) => {
    if (event.defaultPrevented || terminalTarget(event.target)) return;
    event.preventDefault();
    const target = event.target instanceof Element ? event.target : null;
    const field = target?.closest("input,textarea");
    const textField =
      field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field
        : null;
    const password =
      textField instanceof HTMLInputElement && textField.type === "password";
    const selectedInput =
      !password &&
      textField?.selectionStart != null &&
      textField.selectionEnd != null &&
      textField.selectionEnd > textField.selectionStart;
    const editable = textField
      ? !textField.disabled && !textField.readOnly
      : !!(target instanceof HTMLElement && target.isContentEditable);
    void api("clipboard:menu", {
      kind: "standard",
      canCopy:
        !!selectedInput || (!password && !!window.getSelection()?.toString()),
      editable,
    }).catch(onError);
  };
  document.addEventListener("keydown", keydown);
  document.addEventListener("contextmenu", contextmenu);
  return () => {
    document.removeEventListener("keydown", keydown);
    document.removeEventListener("contextmenu", contextmenu);
  };
}
