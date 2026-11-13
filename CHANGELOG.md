# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Hardware ceremony records live in [`docs/ceremony-results.md`](docs/ceremony-results.md).

## [0.7.0] — 2026-11-13

### Added — the bypass status surface (US-1846..1856)

- **The bypass ledger** (US-1846): GET_AUDIT (vendor `0x50`) renders the
  operations the armed bypass exempted from the press — op, slot, timestamp,
  digest — behind the same custody gate every identity command sits behind;
  a closed session renders "verify the PIN to see bypass activity", never an
  error.
- **The status line with a live countdown** (US-1851): "bypass armed —
  N operations left · expires in M:SS", ticking between polls off the
  firmware's sampled session age (v0.3 GET_AUDIT body); at local zero the
  popup re-asks the device instead of trusting the local count.
- **An honest checkbox** (US-1852/1853): checked = "Bypass active —
  signatures run without a touch", unchecked = "Bypass not active —
  signatures need a touch"; the state renders from the device's fresh
  get_audit word, and **checking arms the bypass** (the consent press
  belongs to the arm direction — the first cut had the polarity inverted
  and shipped a checkbox that could never stay checked).
- **A firmware-update notice** (US-1854): boards predating the accounting
  surface (no caps bit 5, or the caps bit on a v0.2 body) show "the bypass
  status needs a firmware update — this board predates it" instead of
  hiding silently.
- **`SECURITY.md`**: the extension's security policy — what it never sees
  (key material; no export verb exists), what only trusted surfaces can
  reach (bypass state, the ledger), and how to report.

### Fixed (US-1853/1856 review passes)

- The bypass checkbox renders the device word, not the cached view — an
  expired session can no longer leave the toggle claiming an armed bypass.
- The countdown tick stops on every screen change; failure paths re-render
  the toggle and never freeze a stale armed line.
- The test mock models the v0.3 board its GET_AUDIT body claims (the hybrid
  fixture had left the ledger unreachable from every device-level test).

## [0.6.0] — 2026-11-08

Companion to fapico2 v0.6.0 (the entropy releases); the release gate and
ceremony records carry the board-run entries.

## [0.5.0] — 2026-11-04

Companion to fapico2 v0.5.0 — the touch bypass ships (US-1741..1749): the
PIN manage screen gains the touch-policy control (pre-US-1852 polarity:
checked = touch required).
