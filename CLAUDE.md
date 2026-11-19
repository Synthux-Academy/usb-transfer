# usb-transfer: notes for agents

The shared USB transfer layer of Synthux Academy instruments. Read [README.md](README.md) for
what's here and how a device uses it, and [docs/protocol.md](docs/protocol.md) for the wire
protocol. This file covers what you need before changing anything.

## What's shared and what isn't

| Here | In each device repository |
|---|---|
| Frames, CRC, resync, frame errors (`Link`, both sides) | Its commands and their payloads |
| HELLO/PING/EXIT dispatch, idle and connect timeouts (`Server`) | Its HELLO body (`Handler::hello`, `parseHello`) |
| Status codes 0–4 | Its status codes from 5 up, and all status texts beyond the defaults |
| SysEx enter/reply format (`sysex.h`, `enterTransferMode`) | Its SysEx signature / frame magic, preconditions, reply codes |
| Chunked-write and ranged-read recovery on the host (`writeChunk`, `readRange`) | The device side of those commands |
| Port picking, authorisation, handshake (`connect`) | Its mode switch: stopping audio/UI, USB MIDI off and on, LEDs |
| Frame buffers: the device passes them in | Where they live and how big they are |

Rule of thumb: if a change needs a device's name, command ID or storage, it belongs in the
device's repository. If two devices would write the same code, it belongs here.

## Consumers

- **Spotykach** (`Synthux-Academy/Spotykach`): submodule at `lib/usb-transfer`.
  - `src/transfer/service.*` is its `Handler` (SD card slots, settings, small files).
  - `web/spotykach-transfer/` is its host package. It imports `@synthuxacademy/usb-transfer`; the
    page maps that name to `web/usb-transfer` (a symlink to the submodule's `js/`) with an import
    map, the tests through `node_modules/` that `tests/transfer/run.sh` links.
  - `tests/transfer/run.sh` builds this C++ with its own and runs its full suite. Run it after any
    change here.
  - Its wire protocol (1.x) shipped before this repository existed. Changes here must keep it
    byte-for-byte: frame layout, magic `SK`, `BAD_FRAME` type `0x80`, its HELLO at its offsets.
- **Audrey** (`Audrey-III`): planned. Settings only, internal USB port, internal flash, little
  RAM, so small frame buffers (4 KB chunks); magic `AU` is reserved.

## Invariants

- The host sends one request and waits for its reply. The device keeps one frame buffer each
  way. Don't add pipelining without a protocol major version.
- A reply always echoes the request's `seq`; the host ignores replies with another `seq`. That is
  what makes retries safe.
- A frame error never touches the device's session; the host may resend.
- Each request is answered within one `Server::process()` call, from the main loop. Nothing in
  `Server` or `Link` blocks for long, except `send()` waiting up to 200 ms for USB.
- Only one `Link` may be started at a time (the receive callback has no context pointer).
- The JS package has no dependencies and no build step. It must run from a plain `<script
  type="module">` and in Node (tests).
- Error messages are shown to users. They name the device (`device.name`) and say what to do.
  Device packages' tests match some of them (e.g. `/Can't open the Spotykach MIDI port/`).

## Changing things

1. Change both sides together when the wire changes, and update `docs/protocol.md`.
2. Run `test/run.sh` here. Add a test device command or fault in `test/harness.cpp` if you need one.
3. Run each consumer's tests against your working copy (e.g. in Spotykach: point
   `lib/usb-transfer` at your commit, then `tests/transfer/run.sh`).
4. For the JS package, bump `js/package.json` (semver of the API) and keep `index.d.ts` in sync.

Host stubs for libDaisy are in `test/stub/`. A device repository has its own, fuller stubs; they
need `UsbHandle::TransmitInternal`/`TransmitExternal`, `hUsbDeviceFS`/`hUsbDeviceHS` and
`usbd_mode`, because `link.cpp` references both ports.
