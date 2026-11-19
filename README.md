# usb-transfer

The shared part of the USB transfer mode of Synthux Academy's Daisy-based instruments: a web page
switches the instrument's USB port from MIDI to a serial device and talks to it in CRC-checked
frames, e.g. to manage samples or edit settings.

- **`cpp/usb_transfer/`**: firmware side, on libDaisy. The frame link over USB CDC, the session
  loop that answers HELLO/PING/EXIT and frame errors, and the SysEx helpers. A device plugs in its
  own commands through a `Handler`.
- **`js/`**: host side, the npm package `@synthuxacademy/usb-transfer`. The SysEx switch over Web
  MIDI, the frame link over Web Serial with loss recovery, and the connection flow. A device
  describes itself with `defineDevice()` and adds its commands on top of `Link`.
- **`docs/protocol.md`**: the wire protocol both sides share.
- **`test/`**: the C++ built for the host with a test device, and the JS run against it.

| Device | Firmware | Host package |
|---|---|---|
| Spotykach | [Synthux-Academy/Spotykach](https://github.com/Synthux-Academy/Spotykach), `src/transfer/` | `@synthuxacademy/spotykach-transfer` (`web/spotykach-transfer/`) |

## Firmware

Add the repository as a submodule, e.g. at `lib/usb-transfer`, and build its sources:

```make
CPP_SOURCES += $(wildcard lib/usb-transfer/cpp/usb_transfer/*.cpp)
C_INCLUDES += -Ilib/usb-transfer/cpp
```

Then implement a `Handler` and run a `Server` while transfer mode is active:

```cpp
#include "usb_transfer/server.h"
#include "usb_transfer/sysex.h"

using namespace usb_transfer;

static constexpr size_t kMaxPayload = 4096 + 16;
static uint8_t rx_buffer[frame_size(kMaxPayload)];
static uint8_t tx_buffer[frame_size(kMaxPayload)];

class Settings: public Handler {
  public:
    void hello(Server& server, const Link::Frame& frame) override {
        auto p = server.payload();
        p[0] = static_cast<uint8_t>(Status::ok);
        p[1] = 1; // proto_major
        p[2] = 0; // proto_minor
        // ... the device's own fields
        server.send(frame, 3);
    }
    bool handle(Server& server, const Link::Frame& frame) override {
        switch (frame.type) {
            case 0x40: /* ... */ server.reply(frame, Status::ok); return true;
            default: return false; // the server replies UNKNOWN_CMD
        }
    }
};

Settings settings;
Server server;

void init() {
    Server::Config config;
    config.link = { Link::Port::internal, { 'A', 'U' }, rx_buffer, tx_buffer, sizeof(rx_buffer) };
    server.init(config, &settings);
}

// On the enter SysEx (sysex::is_enter): reply with sysex::reply, stop USB MIDI, wait ~200 ms,
// server.begin(). Then from the main loop: server.process(); when server.should_exit():
// server.end(), wait ~200 ms, start USB MIDI again.
```

The receive callback is a plain function, so only one `Server` may run at a time. USB doesn't use
DMA, so the buffers can live in any RAM.

## Host

```js
import { defineDevice, Link, connect, authorizePort, NeedsAuthorizationError } from "@synthuxacademy/usb-transfer";

class AudreyLink extends Link {
  static open(port) { return super.open(port, AUDREY); }
  constructor(port, device = AUDREY) { super(port, device); }
  async readSettings() { return (await this.request(0x40)).subarray(4); }
}

const AUDREY = defineDevice({
  name: "Audrey",
  magic: "AU",
  protoMajor: 1,
  Link: AudreyLink,
  parseHello: p => ({ protoMajor: p[1], protoMinor: p[2] }),
});

let connection;
try {
  connection = await connect(AUDREY);           // from a click
} catch (e) {
  if (!(e instanceof NeedsAuthorizationError)) throw e;
  connection = await authorizePort(AUDREY);     // first use: from a fresh click
}
const { link, info } = connection;
await link.readSettings();
await link.exit();                              // back to USB MIDI
```

`index.d.ts` documents every field of `defineDevice` and every method. Without a bundler, import
`js/index.js` by path or map `@synthuxacademy/usb-transfer` to it with an import map.

## Tests

```sh
test/run.sh
```

Builds `cpp/usb_transfer` for the host under AddressSanitizer/UBSan with a test device (internal
port, 4 KB chunks, faults injected through `FAULT`), and runs the JS against it over a fake serial
port: chunked writes and ranged reads through corrupted, lost, stalled, cut and dropped frames,
frame errors, garbage, timeouts, and the SysEx switch with mocked timers. Needs a C++17 compiler
and Node 20+. Device repositories run their own tests against this code too, through their
submodule.

## Releasing the JS package

1. Update `version` in `js/package.json` and commit.
2. Push a tag `v<version>`, e.g. `v1.0.0`.

`.github/workflows/publish.yml` runs the tests, checks the tag against `package.json`, and
publishes through npm trusted publishing. The first version has to be published by hand
(`npm publish --access public` in `js/`), because a trusted publisher can only be added to a
package that exists.

Firmware takes the C++ through the submodule commit, so it has no release of its own. Bump the
submodule in each device repository when the protocol code changes, and run its tests.
