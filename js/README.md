# @synthuxacademy/usb-transfer

Host side of the USB transfer mode of Synthux Academy's Daisy-based instruments, for web apps in
Chromium-based browsers. It:

- switches the instrument from USB MIDI to transfer mode (SysEx over Web MIDI);
- talks to it over Web Serial in CRC-checked request/response frames, one at a time;
- recovers from corrupted, lost and stalled frames, for chunked writes and ranged reads;
- finds, authorises and reopens the serial port.

Each instrument has its own package on top, e.g. `@synthuxacademy/spotykach-transfer`. Use that
one to talk to an instrument; use this one to write such a package.

The firmware side and the protocol are in the [usb-transfer repository](https://github.com/Synthux-Academy/usb-transfer)
(`cpp/`, `docs/protocol.md`).

## Use

```js
import { defineDevice, Link, connect } from "@synthuxacademy/usb-transfer";

class MyLink extends Link {
  static open(port) { return super.open(port, MY_DEVICE); }
  constructor(port, device = MY_DEVICE) { super(port, device); }
  async readSettings() { return (await this.request(0x40)).subarray(4); }
}

const MY_DEVICE = defineDevice({ name: "Audrey", magic: "AU", protoMajor: 1, Link: MyLink });

const { link, info } = await connect(MY_DEVICE); // from a click
```

`index.d.ts` documents every `defineDevice` field and `Link` method. It's a single framework-free
ES module with TypeScript types and no dependencies.

## Versioning

Semantic versioning of the API. The wire protocol's shared part (frames, HELLO/PING/EXIT, frame
errors) doesn't change within a major version.
