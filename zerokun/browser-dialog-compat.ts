/** Preserve the debugger when input opens a blocking JavaScript dialog.
 * A CDP input timeout does not mean the input failed: the dialog can be open
 * while Chromium is still waiting to complete the input response. Detaching
 * loses the dialog and makes reattachment's focus setup block on that dialog.
 * Apply only to the job-owned distribution copy, never policy or approvals.
 */
export function browserDialogCompatibility(source: string): { source: string; applied: boolean } {
  const before = 'method:n,commandParams:o??{},...i.preserveDebuggerOnTimeout===!0?{preserveDebuggerOnTimeout:!0}:{},timeoutMs:c'
  const after = 'method:n,commandParams:o??{},...i.preserveDebuggerOnTimeout===!0||n==="Input.dispatchMouseEvent"||n==="Input.dispatchKeyEvent"||n==="Page.handleJavaScriptDialog"?{preserveDebuggerOnTimeout:!0}:{},timeoutMs:c'
  // An unknown implementation keeps its own behavior. This never prevents a
  // new distribution from loading and never applies a partial replacement.
  if (source.split(before).length !== 2) return { source, applied: false }
  return { source: source.replace(before, after), applied: true }
}
