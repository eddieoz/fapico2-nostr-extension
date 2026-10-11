// US-1708 — the CDP smoke gate entry. The gate itself lands with the story;
// until then the entry exists so CI's step resolves, and skips cleanly when
// Chrome is not available (the flag gate: CHROME_PATH unset = skip).
if (!process.env.CHROME_PATH) {
  console.log('smoke: skipped — CHROME_PATH unset');
  process.exit(0);
}
console.log('smoke: not implemented until US-1708');
process.exit(1);
