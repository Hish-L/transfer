# flight — files over light

<p align="center">
  <img src="docs/hero.svg" width="520"
       alt="A file leaves one screen as QR codes and is read back by another device's camera, with no network between them." />
</p>

Move a file between two devices using nothing but a screen and a camera. One
screen displays the file as an endless stream of animated QR codes; the other
device points its camera at it and rebuilds the file. **No network path between
them** — no Wi-Fi, no Bluetooth, no pairing, no account, no app.

<p align="center"><strong>→ <a href="https://hish-l.github.io/transfer/">hish-l.github.io/transfer</a></strong></p>

Open **Send** on one device, **Receive** on the other, and hold them face to
face. Nothing is offered to you until the file's SHA-256 matches.

## From a terminal

```sh
curl -fsSL https://hish-l.github.io/transfer/qr.sh | bash -s -- myfile.pdf
```

Then open the [receiver](https://hish-l.github.io/transfer/receive/) on a phone
and point it at your terminal. macOS and Linux; python3 is the only requirement.

```text
qr report.pdf                 send a file at the defaults
qr --text "wifi password"     send a text snippet
qr photo.jpg --fps 8          slow it down for a fussy camera
qr big.tar --dense            use the whole terminal (up to V40)
qr --selftest                 check your terminal, font and camera in 10 seconds
qr --help                     everything else
```

It prints a preflight summary, then loops forever — stop it yourself once the
receiver says the file is verified; the sender has no way to know.

```text
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

### If nothing decodes

The code is drawn one module per character cell, so its physical size *is* your
font size — bigger font, bigger code; smaller font, more data per frame. A
default 80×24 window is too small to send anything substantial.

Three things break decoding outright:

- terminal **background transparency, background images, or window blur** — the
  camera sees your wallpaper mixed into the code;
- "dim" or "faint" text rendering;
- a terminal that draws the half-block characters with seams.

<details>
<summary>Why macOS Terminal.app is a special case</summary>

The dense mode packs two module rows into every text row using `▀`/`▄`, which
only tiles if the terminal fills the character cell with them. Windows Terminal,
iTerm2, kitty, WezTerm and Ghostty all synthesise the block elements themselves
and are pixel-exact. Terminal.app renders them as font outlines instead:
antialiased, not spanning the line height, leaving a hairline of background
between each pair of module rows. It still looks fine to a human and still will
not decode — so **Terminal.app gets `--render full` automatically**.

`--render full` paints each module as a background colour behind a space, so it
depends on no font at all and cannot seam. Pass `--render half` to force the
dense mode anyway if your terminal tiles the blocks cleanly.

It will look like a much smaller code, and the fix is your font size. A module
has to stay square — a decoder rejects stretched ones — so `--render full`
spends two cells across and one down where the dense mode spends one across and
half a one down. That is 4x the character cells for the same code, which at a
fixed window means half the modules per side:

| terminal size | `--render half` | `--render full` |
|---|---|---|
| 120x30 | V7, 154 B/frame | nothing fits |
| 200x50 | V17, 644 B/frame | V5, 106 B/frame |
| 240x60 | V22, 1003 B/frame | V8, 192 B/frame |

Halving the font size gets all of it back, and gives a physically identical
code: what the camera sees is the module's size on screen, not how many
character cells were spent drawing it.

The default frame rate is 12, not 60 like the web sender. A canvas blit is free
and a 17 KB terminal repaint is not, a 30 fps camera wants each frame held for
at least two capture intervals, and Terminal.app tears above about 15.

</details>

## How it works

A camera pointed at a screen is a **one-way link**, so the sender never waits to
be asked: it emits an endless stream of **fountain-coded** frames, each a
pseudorandom mix of the file's blocks. The receiver rebuilds the file from any
sufficient set of distinct frames, in any order — roughly 1.15 to 1.4 times as
many frames as there are blocks. Dropped, blurred, duplicated and out-of-order
frames just cost time.

Three independent integrity checks run on the way back: a checksum over the
container, the gzip trailer's own length, then SHA-256 over the original bytes.

<details>
<summary>The wire path, end to end</summary>

```text
file ─→ SHA-256 ─┐
                 ├─→ "DCF2" container ─→ LT blocks ─→ XOR ─→ frame header ─→ QR byte mode
     └─→ gzip? ──┘                                                                  │
                                                                              camera │
receiver ←── SHA-256 ←── gunzip ←── unpack ←── FNV-1a ←── peel ←── parse ←───────────┘
```

The fountain code is LT with a robust soliton distribution.

</details>

## Reading the receiver's panel

The receiver keeps a live diagnostic panel, because when an optical link
misbehaves the useful question is always *which layer*:

| metric | what it tells you |
|---|---|
| `capture fps` | frames the camera delivered |
| `decode fps` | frames actually read — the gap to capture fps is your focus/glare problem |
| `goodput` | payload KB/s, discounted by the fountain overhead expected at this transfer's size |
| `frames new/dup`, `dup rate` | how much of what you're reading is the same frame twice |
| `overhead` | unique frames per source block, against the expected value — the single most diagnostic number here |
| `passes`, `blocks K`, `block len`, `transfer`, `solved` | where the transfer is |

Plus a 60-second sparkline of decode fps, which makes a camera hunting for focus
visible as a shape rather than a jittering number.

## On `curl | bash`

`qr.sh` fetches `qrsend.py`, checks it against a SHA-256 pinned at build time,
caches it under `~/.cache/qrtransfer`, and hands over. That pin catches a
truncated or corrupted download — it's **not** protection from a compromised
origin. Piping a URL into a shell is trust-on-first-use of that origin.

If you would rather look first:

```sh
curl -fsSLO https://hish-l.github.io/transfer/qr.sh && less qr.sh
bash qr.sh myfile.pdf
```

Other bootstrap flags: `--install` (put a `qr` command in `~/.local/bin`; it
warns if that is not on your `PATH` and never edits your shell rc files),
`--uninstall`, `--update`, `--offline`, `--local FILE`, `--bootstrap-help`.

## This is not encrypted

> [!WARNING]
> Whatever is on the sending screen is readable by any camera pointed at it,
> including one you did not notice. **The property you get is "no network", not
> confidentiality.**

If you need the payload secret, encrypt it before sending — `age`, `gpg`, an
encrypted archive — and transfer the ciphertext.

## Development

```sh
npm install
npm run dev        # https, because getUserMedia does not exist on http
npm run build
npm run test:all   # everything below, in order
```

| command | what it checks |
|---|---|
| `npm test` | golden wire-format vectors for the TypeScript codec |
| `npm run test:parity` | the Python sender against those same vectors, plus the QR encoder against node-qrcode across all 160 version × ECC combinations |
| `npm run test:loopback` | frames from the Python sender, fed to the real browser decoder |
| `npm run test:decode` | the Python QR encoder's output, read back by the receiver's own zxing build |

```text
index.html · home.ts        landing page
send/ · receive/            the two tools
shared/                     codec (vendored), plus theme.css
cli/  qrsend.py qr.sh.in    the terminal sender and its bootstrap
build/                      vite plugins: html tokens, CLI payload + hash pin
tests/                      golden vectors, parity, loopback, decodability
docs/                       README assets
```

<details>
<summary>Why so much of the sender is wire format</summary>

The sender and receiver derive every frame's block subset **independently and
never compare notes**. Any arithmetic that differs by one ulp desynchronises
them silently — the transfer simply never completes. That makes a surprising
amount of `cli/qrsend.py` wire format rather than implementation:

- a hand-rolled `dlog`, because `Math.log` is implementation-approximated and V8
  and JavaScriptCore can disagree by an ulp;
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

The dev server is https via a self-signed certificate, which is load-bearing:
`getUserMedia` does not exist on an insecure origin, so a phone opening the dev
server over the LAN would get no camera at all.

</details>
