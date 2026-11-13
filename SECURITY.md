# Security Policy

## What this extension never sees

Key material never reaches the extension. The private keys live on the
fapico2 board's sealed store, custody is **import-only** — there is no
export verb in any firmware dialect (the retired byte answers `6D00`) — and
the extension has no code path that could carry a secret off the board even
if it wanted to.

## What is trusted-only

The MV3 service worker refuses device calls from web pages before the
handler runs. Bypass state, the operation ledger (`get_audit`) and the
touch policy (`touch_policy_set`) are **trusted-only** methods: a tab sender
gets `ForbiddenMethodError` and the device is never framed. Only the
extension's own popup surfaces the armed state, the countdown and the
ledger — and even that read is PIN-session-gated on the device, so a
sessionless host learns nothing, not even the budget.

## The consent ceremony

Arming the touch bypass costs an open PIN session **and a physical press on
the board** — the extension can only ask; the firmware enforces the press
and the bounds (255 exempt operations, 10 minutes). Disarming is
friction-free by design. Every other private-key operation asks for the
touch; key-set changes (generate, import, label, delete) press the button
unconditionally.

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Report privately — do not open public issues. Contact: the repository
owner's security contact (see the fapico2 board repo's
[`SECURITY.md`](https://github.com/eddieoz/fapico2/blob/main/SECURITY.md)
for the channel; the same rules apply here).
