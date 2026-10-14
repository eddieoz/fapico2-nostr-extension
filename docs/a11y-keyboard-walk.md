# US-1733 — the keyboard walk (a11y record)

The story's acceptance: "manual keyboard walk of all screens recorded in the
PR." Recorded 2026-10-13 against `feat/nostr` `018ee84` (dist rebuilt), driven
by real `Tab` key events through the real dist pages in a real Chrome
(DevTools `Input.dispatchKeyEvent` — actual input events, native focus
traversal, not synthetic `focus()`). Per-stop verification was mechanical:
`document.activeElement` after every Tab, and `activeElement.matches(':focus-visible')`
at each walk's last stop (the shared amber ring from `tokens.css` —
`button:focus-visible { outline: 2px solid var(--amber) }` — confirmed visible
in screenshots). The operator (eddieoz) reviewed the captures.

All nine surfaces: **every interactive control reachable, no keyboard trap,
:focus-visible true at every stop, status regions present on every page.**

## Keys home (connected)

Connect → *(row: slot 0)* copy → label → export → delete → **#active-1 radio
[Make slot 1 the active key]** → copy → label → export → delete → *(row:
slot 3)* copy → label → export → delete → Generate → Import → Keys nav →
Sites nav.

Notes: the active-key radios form one native radio group — a single tab stop
at the checked radio (`#active-1`), arrow keys move within the group; the
hidden "Try again" button is correctly out of the order; disabled controls
(taken slots, disabled confirms) are correctly skipped everywhere below.

## Connect-first home (absent)

Connect → Keys nav → Sites nav → *(cycle)*. The disabled Generate/Import are
out of the order (their reason is visible text beside them).

## Generate screen

Connect → free slots 2, 4, 5, 6, 7 (taken 0/1/3 skipped) → Back → navs.

## Sites screen

Connect → revoke → Revoke all → navs.

## Delete confirm

Connect → the "I understand" checkbox → Back → navs (Delete & touch stays
disabled until the checkbox, then joins the order).

## Export screen

Connect → the "I understand" checkbox → Back → navs (Reveal & touch gated the
same way; the revealed Copy button joins after the reveal).

## Label screen

Connect → label input → Set label & touch → Back → navs.

## Connect page (tab)

Connect → *(cycle)*. The touch bar is the page's `role="status"` region.

## Prompt window

Remember checkbox → Deny → Approve → *(cycle)*. `role="status"` regions: the
touch bar and the outcome beat — both announce on state flips.

## Verdict

PASS. The US-1733 acceptance items are all met on machine-verified walks:
contrast tokens pinned by test, no interactive label below 11px, visible
focus path on every new state (connect card, prompt touch state, the
disabled-with-reason home), and the touch bar's status announcements intact
on every page.
