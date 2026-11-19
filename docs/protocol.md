# USB transfer protocol

The part of the protocol every device shares. A device's own spec adds its commands, its status
codes from 5 up and its HELLO body. [Spotykach's](https://github.com/Synthux-Academy/Spotykach/blob/main/docs/usb-transfer.md)
is the first and fullest example.

This is not USB mass storage. A device normally shows up as USB MIDI. When the host asks, it
switches its USB port into **transfer mode**: the MIDI device goes away and a USB CDC (virtual
serial) device appears. A browser talks to it over Web Serial with the frames below. When the
session ends, the device switches back to MIDI.

## 1. Mode lifecycle

```
            SysEx "enter" (USB MIDI)
  NORMAL ───────────────────────────────▶ TRANSFER
 (USB MIDI)   reply OK, then re-enumerate  (USB CDC)
     ▲                                       │
     └───────────────────────────────────────┘
        EXIT / a device gesture / timeout
```

### 1.1 Entering

1. The host sends the **enter** SysEx (§2) to the device's USB MIDI output port.
2. The device handles it only if it came over USB MIDI, not DIN.
3. The device checks its own preconditions (not recording, card present...). If they fail, it
   replies with a non-zero status and stays in MIDI mode.
4. Otherwise it replies `0`, flushes MIDI out, and waits about 150 ms. The page closes its MIDI
   ports as soon as the reply arrives: on Windows, Chrome's MIDI service can hang until the
   browser quits when a port is still open while its device leaves USB.
5. The device stops USB MIDI, waits about 200 ms so the host notices the disconnect, and starts
   CDC on the same port (`usb_transfer::Server::begin`).
6. The host sees the MIDI device go and a serial device appear, usually within about 1 s.

### 1.2 Leaving

- An `EXIT` command. The device replies first.
- A gesture on the device (Spotykach: the Play pads).
- **10 s** without a valid frame once the host has connected, or **60 s** before the first one,
  so the user has time to pick the port in Chrome's picker on first use. While idle, the host
  sends `PING` every 2 s.
- DTR isn't used: libDaisy's CDC class ignores line-state changes, and the timeout covers a
  closed tab.

On leaving, the device drops its session (`Handler::reset_session`), stops CDC, waits about
200 ms and starts USB MIDI again.

## 2. SysEx

There's no registered manufacturer ID, so every device uses the non-commercial ID `0x7D`
followed by two ASCII signature bytes, by convention the same as its frame magic (§3.2).

| Direction | Bytes | Meaning |
|---|---|---|
| Host → device | `F0 7D s0 s1 01 F7` | Enter transfer mode |
| Device → host | `F0 7D s0 s1 02 <status> F7` | `00` OK, switching now. Other values are the device's (Spotykach: `01` busy, `02` no card) |

The host sends the request at most twice and waits 2 s, then 3 s, for the reply (the device can
set other times). If the MIDI output port disappears meanwhile, the device switched and only its
reply got lost. `cpp/usb_transfer/sysex.h` builds and checks these messages.

| Device | Signature / magic |
|---|---|
| Spotykach | `SK` |
| Audrey | `AU` (reserved, not implemented yet) |

Pick a new pair for a new device and add it here. All devices share the USB IDs
`0x0483:0x5740`, so the magic is what tells their serial ports apart.

## 3. Frames

### 3.1 Transport

- USB CDC ACM, Full Speed. Baud rate and line settings are ignored.
- **Strict request/response.** The host sends one request and waits for its response before
  sending the next. So the device's receive buffer holds one frame, and there's no flow control.
- All integers are little-endian. Strings are UTF-8 with a length prefix and no NUL.

### 3.2 Layout

| Offset | Size | Field |
|---|---|---|
| 0 | 2 | Magic, the device's two ASCII bytes (`"SK"`) |
| 2 | 1 | `type`: the command ID; a response is the command ID \| `0x80` |
| 3 | 1 | `seq`: set by the host, increased per request, echoed in the response |
| 4 | 4 | `len`: payload length in bytes, at most the device's `max_payload` |
| 8 | 4 | `crc`: CRC-32 (IEEE 802.3 / zlib) over bytes 2–7 followed by the payload |
| 12 | len | Payload |

- Every response payload starts with `status: u8`.
- The device picks `max_payload` (its frame buffers are `12 + max_payload` bytes each). By
  convention it's the largest data chunk plus 16, and HELLO reports the chunk size. Spotykach:
  32 KB chunks. A device with little RAM uses smaller ones; the host adapts.
- Data-bearing payloads start with a 4-byte field, so data starts at frame offset 16 and stays
  4-byte aligned in the device's buffer (Spotykach's SD DMA needs that).

### 3.3 Frame errors

Bad magic, `len > max_payload`, a CRC mismatch, an overflowing receive buffer, or a partial frame
that has received nothing for 2 s. On any of these the device:

- drops its receive buffer, then discards incoming bytes until the line has been quiet for
  100 ms, so the rest of a broken frame isn't taken for a new one;
- replies `BAD_FRAME` with `type = 0x80` (the response type of the reserved command `0x00`;
  `0xFF` can't be used, it's the response to `EXIT`). The payload is `status u8, reason u8`:
  `1` checksum mismatch, `2` a partial frame stopped arriving, `3` receive buffer overflow,
  `4` length above `max_payload`, `0` unknown;
- keeps its session as it was, because the broken frame was never processed.

The host may resend after waiting at least the quiet time (it waits 250 ms). Bytes before a
magic are discarded on both sides, which covers modem probing on Linux and frames of another
device.

## 4. Commands every device answers

| ID | Name | Request | Response (after status) | Notes |
|---|---|---|---|---|
| `0x00` | — | never sent | `type 0x80` marks frame errors | |
| `0x01` | HELLO | — | device's body | Resets the device's session. By convention the body starts `proto_major u8, proto_minor u8`. The host refuses another major version |
| `0x02` | PING | — | — | Keep-alive |
| `0x7F` | EXIT | — | — | The device replies, then leaves transfer mode |

A device's own commands use IDs `0x03`–`0x7E`.

## 5. Status codes every device uses

| Code | Name | Meaning |
|---|---|---|
| 0 | OK | |
| 1 | BAD_FRAME | magic, length or CRC error |
| 2 | UNKNOWN_CMD | |
| 3 | BAD_STATE | command not valid in the current session state |
| 4 | BAD_ARG | |

A device's own codes start at 5.

## 6. Conventions for moving data

Two request shapes the host package implements, so a device that follows them gets loss recovery
for free. The command IDs are the device's.

### 6.1 Chunked write (host → device)

- Request: `offset u32, data[≤ chunk]`. Offsets are sequential; the device takes a chunk only at
  the offset it expects.
- Response: `status u8, rsv u8×3, offset u32`, where `offset` is the device's offset after handling
  the request, for any status.
- The device's BAD_OFFSET code (its own number, given to the host as `badOffsetStatus`) answers a
  chunk at the wrong offset.
- The host (`Link.writeChunk`) resends a chunk, up to 5 times, after `BAD_FRAME` or no reply within
  4 s. On a resend, `BAD_OFFSET` with offset = chunk end means the chunk was taken and only the
  reply got lost; offset = chunk start means it wasn't, and the host resends.

Spotykach wraps this in UPLOAD_BEGIN (size, whole-file CRC), UPLOAD_DATA and UPLOAD_COMMIT.

### 6.2 Ranged read (device → host)

- Request: `offset u32, length u32` (≤ chunk). Response: `status u8, rsv u8×3, data[length]`.
- The request names an absolute range, so it can be repeated.
- On macOS the serial tty can drop the tail of a large device-to-host burst. The host
  (`Link.readRange`) counts a reply as lost when it stops arriving for 300 ms partway, or doesn't
  start within 1.5 s, clears its buffer and asks again; a late reply is ignored because its `seq`
  no longer matches. The read size starts at the size that last worked in this browser
  (`localStorage`), halves on each lost reply (down to 1 KB, which becomes a ceiling), doubles back
  after 8 clean reads, and tries above the ceiling after 64. It gives up after 8 lost replies in a
  row.

## 7. Implementation notes

- **Firmware.** `usb_transfer::Server` runs from the main loop while transfer mode is active and
  answers each request within one `process()` call. The device's `Handler` gets HELLO and its own
  commands. The USB receive callback (USB interrupt) copies bytes into the device's receive
  buffer.
- **libDaisy.** MIDI is a mode of libDaisy's patched CDC class, chosen by the global `usbd_mode`
  when the host fetches the configuration descriptor:
  - to CDC: `UsbHandle::DeInit(port)` (the device stops USB MIDI), then `Link::start` sets
    `usbd_mode = USBD_MODE_CDC`, runs `UsbHandle::Init(port)` and `SetReceiveCallback`;
  - back to MIDI: `Link::stop` runs `UsbHandle::DeInit(port)`, then the device's
    `MidiUsbHandler::Init` + `StartReceive`, which sets `usbd_mode = USBD_MODE_MIDI` itself.
  - The patched CDC class sends a zero-length packet when a transfer is a multiple of 64 bytes.
  - TX busy is read from the port's `USBD_HandleTypeDef` (`hUsbDeviceFS` for the internal port,
    `hUsbDeviceHS` for the external one). USB doesn't use DMA, so buffers can be in any RAM.
  - `CDC_Receive_*` re-arms the endpoint before calling the receive callback with libDaisy's own
    buffer, so the callback copies the bytes out right away.
- **USB names.** The page finds the MIDI port by name (`midiPortName`), so the device's USB product
  string must contain it. libDaisy's fork takes `USBD_PRODUCT_STRING_HS` (external port) from the
  firmware; check the internal port's string before relying on it.
- **Risks.**
  - Windows: with legacy WinMM drivers only one app can open a MIDI port, so a DAW holding it
    blocks the SysEx. The page says so.
  - Windows may cache the driver per VID/PID and mis-bind it when the same ID goes from MIDI to
    CDC. Mitigations: a different `bcdDevice` or serial string per mode, or a free PID from
    pid.codes.
  - Linux: Web Serial needs the user in `dialout` (`uucp` on Arch). ModemManager may probe the new
    `ttyACM`; framing resync handles it.
  - DAWs may need a rescan after the MIDI device comes back.
