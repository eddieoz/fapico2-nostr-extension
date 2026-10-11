// US-1692 — the port-based messaging spine: routes {id, method, args} frames
// to the method table, answers {id, result} or {id, error:{name, message,
// code?}}. (Placeholder wiring for US-1689; the table and sender gate land
// with the story's tests.)
export function attachPortListener(port) {
  port.onMessage.addListener(() => {});
}
