# S1 spike — Trystero handshake held open for a human decision (2026-10-01)

Page: `verification/spikes/s1-handshake.html` (`trystero@0.25.4` from esm.sh, default Nostr strategy, real public relays).
Driver: Playwright, installed Chrome headless, three isolated contexts: owner "Deepak", member "Asha", joiner "Ravi".
Protocol under test: both sides `send(hello{name, admitted})` → `receive()`; an established side holding a newcomer
waits — owner for a human decision, member for the owner's `admit` action message — then `send({verdict})` and
resolves (accept) or throws (deny). `handshakeTimeoutMs: 150000`.

## Run 1 — accept after a 60 s hold
```
OWNER   4.6s  Asha ↔ owner both admitted → onPeerJoin (relay discovery ≈ 2–5 s)
        6.6s  hello from Ravi {admitted:false} → ASK HUMAN
       66.9s  decided accept → onPeerJoin Ravi (peers 2)
MEMBER  2.9s  hello from Ravi → waits
       63.2s  admit msg (from owner) → decided accept → onPeerJoin Ravi
JOINER 61.1s  verdict accept from owner AND member → onPeerJoin ×2
       74.9s  Ravi's ping reaches owner and member (normal actions flow after admission)
```
## Run 2 — reject after a 10 s hold
```
OWNER  15.0s decided reject → onJoinError(Ravi, "denied")
MEMBER 13.1s admit msg reject → onJoinError(Ravi, "denied")
JOINER 11.4s verdict reject from both → onJoinError ×2 ("rejected by …")
```

## Findings
- ✅ A pending peer can be held **≥ 60 s** for a human click (`handshakeTimeoutMs` raised to 150 000). Pending peers fire no `onPeerJoin`, no actions, no streams — exactly the "sees nothing until accepted" gate.
- ✅ Members can hold their own handshake until the owner's `admit` arrives over the already-active owner↔member channel.
- ✅ Reject is clean on all three sides via `onJoinError`.
- Action receivers in 0.25 are `(data, {peerId, metadata})` — the 2nd arg is an object, not a bare peerId (spike logged `[object Object]`).
- ⚠ The spike's "both say admitted → accept" is spoofable. Production: admission must be proven by an **admission ticket signed by an approver's stable key** (R2 §5), and a rejected joiner must `room.leave()` (plus a re-request cooldown) so it does not retry forever.
- Relay discovery took 1–5 s per pair on this network.
