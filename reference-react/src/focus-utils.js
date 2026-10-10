export function focusWithAnimationFrame(target, requestAnimationFrameImpl = globalThis.requestAnimationFrame) {
  if (!target || typeof target.focus !== "function" || typeof requestAnimationFrameImpl !== "function") return;
  requestAnimationFrameImpl(() => target.focus());
}
