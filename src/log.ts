const tty = process.stdout.isTTY === true;
const c = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const log = {
  step: (msg: string) => console.log(c(36, "▸") + " " + msg),
  ok: (msg: string) => console.log(c(32, "✓") + " " + msg),
  warn: (msg: string) => console.log(c(33, "!") + " " + msg),
  error: (msg: string) => console.error(c(31, "✗") + " " + msg),
  info: (msg: string) => console.log("  " + msg),
  dim: (msg: string) => console.log(c(90, "  " + msg)),
};

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}
