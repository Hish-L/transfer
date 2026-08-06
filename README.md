# transfer — files over light

Move a file between two devices using nothing but a screen and a camera. One
screen displays the file as an endless stream of animated QR codes; the other
device points its camera at it and rebuilds the file. **No network path between
them** — no Wi-Fi, no Bluetooth, no pairing, no account, no app.

**→ [hish-l.github.io/transfer](https://hish-l.github.io/transfer/)**

The sender also runs in a terminal:

```sh
curl -fsSL https://hish-l.github.io/transfer/qr.sh | bash -s -- myfile.pdf
```

Then open the [receiver](https://hish-l.github.io/transfer/receive/) on a phone
and point it at your terminal. macOS and Linux; python3 is the only requirement.

---

## How it works

A camera pointed at a screen is a **one-way link**. The receiver has no way to
ask for a frame it missed, so the sender never waits to be asked: it emits an
endless stream of **fountain-coded** frames (LT codes, robust soliton
distribution), each a pseudorandom XOR of the file's blocks. The receiver
rebuilds the file from any sufficient set of distinct frames, in any order —
roughly k·1.15 to k·1.4 of them depending on size. Dropped, blurred, duplicated
and out-of-order frames cost time and nothing else.

```
file ─→ SHA-256 ─┐
                 ├─→ "DCF2" container ─→ LT blocks ─→ XOR ─→ frame header ─→ QR byte mode
     └─→ gzip? ──┘                                                                  │
                                                                              camera │
receiver ←── SHA-256 ←── gunzip ←── unpack ←── FNV-1a ←── peel ←── parse ←───────────┘
```

Three independent integrity checks on the way back, in order: FNV-1a over the
container, the gzip trailer's own length, then SHA-256 over the original bytes.
**Nothing is offered to you until the SHA-256 matches.**

## Receiving shows you the numbers

The receiver keeps a live diagnostic panel, because when an optical link
misbehaves the useful question is always *which layer*:

| | |
|---|---|
| `capture fps` | frames the camera delivered |
| `decode fps` | frames zxing actually read — the gap to capture fps is your focus/glare problem |
| `goodput` | payload KB/s, discounted by the fountain overhead expected at this k |
| `frames new/dup`, `dup rate` | how much of what you're reading is the same frame twice |
| `overhead` | unique frames per source block, against the expected value — the single most diagnostic number here |
| `passes`, `blocks K`, `block len`, `transfer`, `solved` | where the transfer is |

Plus a 60-second sparkline of decode fps, which makes a camera hunting for
focus visible as a shape rather than a jittering number.

The goodput discount is a function of k rather than a flat constant: the
often-quoted 1.15 fountain overhead is asymptotic, and a short transfer really
needs closer to 1.4, so a flat figure over-reports small files by up to 2×.

## The terminal sender

```
qr report.pdf                 send a file at the defaults
qr --text "wifi password"     send a text snippet
qr photo.jpg --fps 8          slow it down for a fussy camera
qr big.tar --dense            use the whole terminal (up to V40)
qr --selftest                 check your terminal, font and camera in 10 seconds
qr --help                     everything else
```

It prints a preflight summary before it starts drawing, and loops forever —
stop it yourself once the receiver says the file is verified. The sender has no
way to know.

```
  send        report.pdf            4.7 MB   application/pdf
  compress    gzip                  3.9 MB   (-17%)
  terminal    198 x 74              iTerm2, truecolor
  qr          V27  ECC L  mask 4    125 modules -> 133 cols x 67 rows
  frame       1465 bytes            1445 payload + 20 header
  fountain    k = 2,729 blocks
  rate        12 fps                17.3 KB/s
  one pass    best  3m 47s          2,729 frames
              typical 4m 21s        3,139 frames  (k x 1.15)
```

**Making it readable.** The code is drawn one module per character cell, so its
physical size *is* your font size — bigger font, bigger code; smaller font, more
data per frame. Rows are almost always the binding constraint, and a default
80×24 window is too small to send anything substantial.

Three things break decoding outright, and they are worth knowing before you
spend ten minutes wondering why nothing reads:

- terminal **background transparency, background images, or window blur** — the
  camera sees your wallpaper mixed into the code;
- "dim" or "faint" text rendering;
- a font that draws the half-block characters with seams. Use `--render full`
  if you hit that: ASCII-only, half the density, always works.

Default frame rate is 12, not 60 like the web sender. A canvas blit is free and
a 17 KB terminal repaint is not, a 30 fps camera wants each frame held for at
least two capture intervals, and Terminal.app tears above about 15.

## On `curl | bash`

`qr.sh` fetches `qrsend.py`, checks it against a SHA-256 pinned at build time,
caches it under `~/.cache/qrtransfer`, and hands over. A warm cache means no
network at all.

Be clear about what that pin buys: both files come from the same origin over
the same connection, so it is **integrity against a truncated or corrupted
download**, plus a payload identity you can audit against the published
release. It is **not** protection from a compromised origin. Piping a URL into
a shell is trust-on-first-use of that origin, and no hash inside the pipe
changes that.

If you would rather look first:

```sh
curl -fsSLO https://hish-l.github.io/transfer/qr.sh && less qr.sh
bash qr.sh myfile.pdf
```

Other bootstrap flags: `--install` (put a `qr` command in `~/.local/bin`; it
warns if that is not on your `PATH` and never edits your shell rc files),
`--uninstall`, `--update`, `--offline`, `--local FILE`, `--bootstrap-help`.

## This is not encrypted

Whatever is on the sending screen is readable by any camera pointed at it,
including one you did not notice. **The property you get is "no network", not
confidentiality.** If you need the payload secret, encrypt it before sending —
`age`, `gpg`, an encrypted archive — and transfer the ciphertext.

## Development

```sh
npm install
npm run dev        # https, because getUserMedia does not exist on http
npm run build
npm run test:all   # everything below, in order
```

| | |
|---|---|
| `npm test` | golden wire-format vectors for the TypeScript codec |
| `npm run test:parity` | the Python sender against those same vectors, plus the QR encoder against node-qrcode across all 160 version × ECC combinations |
| `npm run test:loopback` | frames from the Python sender, fed to the real browser decoder |
| `npm run test:decode` | the Python QR encoder's output, read back by the receiver's own zxing build |

The dev server is https via a self-signed certificate, which is load-bearing:
`getUserMedia` does not exist on an insecure origin, so a phone opening the dev
server over the LAN would get no camera at all.

### The parity problem

The sender and receiver derive every frame's block subset **independently and
never compare notes**. Any arithmetic that differs by one ulp desynchronises
them silently — the transfer simply never completes. That makes a surprising
amount of `cli/qrsend.py` wire format rather than implementation:

- a hand-rolled `dlog`, because `Math.log` is implementation-approximated and
  V8 and JavaScriptCore can disagree by an ulp;
- `total += rho + tau` as a single add, because splitting it changes the last
  bit of a CDF boundary;
- an insertion-ordered `dict` rather than a `set` in the degree sampler;
- the `d > k >> 3` branch, because the two paths consume different numbers of
  PRNG outputs.

So the vectors are **generated**, never transcribed: `tests/extract_vectors.mjs`
dumps them from the same TypeScript modules the browser ships, and the Python
tests consume that JSON. Transcribing them would mean that the first time one
failed, someone would "fix" the constant and the test would stop measuring
anything.

### Layout

```
index.html · home.ts        landing page
send/ · receive/            the two tools
shared/                     codec (vendored), plus theme.css
cli/  qrsend.py qr.sh.in    the terminal sender and its bootstrap
build/                      vite plugins: html tokens, CLI payload + hash pin
tests/                      golden vectors, parity, loopback, decodability
```

