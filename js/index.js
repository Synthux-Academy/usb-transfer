/**
 * USB transfer protocol, host side: the part every device shares.
 *
 * Switches a device from USB MIDI to transfer mode (SysEx), talks to it over Web
 * Serial in CRC-checked request/response frames, and recovers from lost and
 * corrupted frames. A device package describes its device with `defineDevice()`
 * and adds its own commands on top of `Link`. Framework-free ES module; the
 * firmware side is cpp/usb_transfer/ of the same repository, the protocol is
 * described in docs/protocol.md.
 *
 * MIT License, Copyright (c) 2026 Synthux Academy
 */

// Protocol ///////////////////////////////////////////////////////////////////

export const HEADER_SIZE = 12;
export const RESPONSE_FLAG = 0x80;
/** Response type of the reserved command 0x00: the device rejected a frame. */
export const FRAME_ERROR_TYPE = 0x80;

/** Commands every device answers. A device's own commands use the IDs in between. */
export const CMD = Object.freeze({
  hello: 0x01,
  ping: 0x02,
  exit: 0x7F,
});

/** Status codes every device uses. A device's own codes start at FIRST_DEVICE_STATUS. */
export const STATUS = Object.freeze({
  ok: 0,
  badFrame: 1,
  unknownCmd: 2,
  badState: 3,
  badArg: 4,
});
export const FIRST_DEVICE_STATUS = 5;

/** Why the device rejected a frame: `DeviceError.frameError` of a BAD_FRAME from the device */
export const FRAME_ERROR = Object.freeze({
  unknown: 0,
  crc: 1,       // checksum mismatch, bytes changed on the way
  stale: 2,     // a partial request stopped arriving
  overflow: 3,  // more data than the device's receive buffer holds
  badLength: 4, // the header announced a payload that's too large
});

const FRAME_ERROR_TEXT = ["", "checksum mismatch", "the request stopped arriving", "receive buffer overflow", "invalid length"];

/** The SysEx manufacturer ID every device uses (non-commercial), followed by its two signature bytes. */
export const SYSEX_MANUFACTURER = 0x7D;
const SYSEX_ENTER = 0x01;
const SYSEX_REPLY = 0x02;

// Devices ////////////////////////////////////////////////////////////////////

/**
 * A device's description, filled in with the defaults. Only `name`, `magic` and
 * `protoMajor` are required; see index.d.ts for every field.
 */
export function defineDevice(spec) {
  const { name, magic, protoMajor } = spec;
  if (!name) throw new Error("defineDevice: name is required.");
  if (typeof magic !== "string" || magic.length !== 2) throw new Error("defineDevice: magic must be two ASCII characters.");
  if (!Number.isInteger(protoMajor)) throw new Error("defineDevice: protoMajor is required.");
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const magicBytes = [magic.charCodeAt(0), magic.charCodeAt(1)];
  const statusText = [...defaultStatusText(name)];
  (spec.statusText || []).forEach((text, i) => { if (text) statusText[i] = text; });
  return Object.freeze({
    usbVendorId: 0x0483,
    usbProductId: 0x5740,
    midiPortName: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    connectHint: "",
    maxPayload: 32768 + 16,
    enterText: {},
    enterReplyMs: [2000, 3000],
    badOffsetStatus: null,
    parseHello: p => ({ protoMajor: p[1], protoMinor: p[2] }),
    storageKey: id,
    logTag: id,
    Link,
    ...spec,
    magicBytes: Object.freeze(magicBytes),
    sysexSignature: Object.freeze(spec.sysexSignature || [SYSEX_MANUFACTURER, ...magicBytes]),
    statusText: Object.freeze(statusText),
  });
}

function defaultStatusText(name) {
  return [
    "OK",
    "Transfer error (corrupted frame). Please retry.",
    `${name} doesn't know this command. Update its firmware.`,
    `${name} is busy with another operation.`,
    "Invalid request.",
  ];
}

// Errors /////////////////////////////////////////////////////////////////////

/** The device answered with a status other than OK. `reply` is the reply payload when there was one. */
export class DeviceError extends Error {
  constructor(status, message, reply) {
    super(message || `Device error ${status}.`);
    this.name = "DeviceError";
    this.status = status;
    this.reply = reply || null;
    /** For a frame the device rejected: one of FRAME_ERROR, otherwise null. */
    this.frameError = null;
  }
}

/** No (complete) reply in time. `detail` tells a silent device apart from bytes lost on the way. */
export class TimeoutError extends Error {
  constructor(detail, deviceName = "The device") {
    super(`${deviceName} didn't respond in time.`);
    this.name = "TimeoutError";
    this.detail = detail;
  }
}

/** First use on this computer: the serial port needs a grant, call `authorizePort()` from a click. */
export class NeedsAuthorizationError extends Error {
  constructor(deviceName = "the device") {
    super(`Select ${deviceName} in the browser's port picker. This is needed only once per computer.`);
    this.name = "NeedsAuthorizationError";
  }
}

/** No USB MIDI port of the device: not connected, or already in transfer mode without a granted serial port. */
export class MidiPortNotFoundError extends Error {
  constructor(deviceName = "Device", connectHint = "") {
    super(`${deviceName} MIDI port not found.${connectHint ? ` ${connectHint}` : ""}` + portHint());
    this.name = "MidiPortNotFoundError";
  }
}

/** The device speaks another protocol major version. */
export class ProtocolMismatchError extends Error {
  constructor(major, minor, supportedMajor, deviceName = "The device") {
    super(`${deviceName} uses transfer protocol ${major}.${minor}, this app supports ${supportedMajor}.x. Update the app or the firmware.`);
    this.name = "ProtocolMismatchError";
    this.major = major;
    this.minor = minor;
  }
}

// Helpers ////////////////////////////////////////////////////////////////////

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const platform = () => (typeof navigator !== "undefined" && navigator.platform) || "";
const isWindows = () => /Win/.test(platform());
const isLinux = () => /Linux/.test(platform()) && !/Android/.test((typeof navigator !== "undefined" && navigator.userAgent) || "");
const portHint = () => (isWindows() ? " On Windows, close other apps (e.g. your DAW) that use its MIDI port." : "");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, same as zlib). Pass the previous result as `crc` to continue over more data. */
export function crc32(data, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/*
Ranged reads (readRange) name an absolute offset and length, so they can be repeated.
On macOS the serial tty can drop the tail of a large burst when the browser doesn't
drain it fast enough, so the read size adapts: halve on a lost reply and stay below
the size that failed; try that size again only after a long run of clean reads.
*/
const MIN_READ_CHUNK = 1024;
const GROW_AFTER = 8;
const PROBE_AFTER = 64;
const MAX_READ_FAILURES_IN_ROW = 8;

/*
Chunked writes (writeChunk): a chunk is resent after a corrupted frame or a lost reply.
The device only advances after taking a chunk and reports its offset with every
reply, so BAD_OFFSET on a resend tells whether the chunk was taken already.
*/
const MAX_UPLOAD_RETRIES = 5;
const UPLOAD_DATA_TIMEOUT_MS = 4000; // well below the device's 10 s idle timeout
const DEVICE_QUIET_MS = 250;         // the device drops a broken frame's rest until 100 ms of quiet

const KEEP_ALIVE_MS = 2000;
const OPEN_ATTEMPTS = 8;               // 250 ms apart: about 2 s
const OPEN_ATTEMPTS_LINUX_FRESH = 24;  // about 6 s, past a ModemManager probe

function loadReadChunk(key, maxChunk) {
  try {
    const saved = parseInt(globalThis.window?.localStorage?.getItem(key) ?? "", 10);
    if (saved >= MIN_READ_CHUNK) return Math.min(saved, maxChunk);
  } catch (e) { /* storage blocked */ }
  return maxChunk;
}

function saveReadChunk(key, chunk) {
  try {
    globalThis.window?.localStorage?.setItem(key, String(chunk));
  } catch (e) { /* storage blocked */ }
}

/**
 * `e` with `detail` appended to its message. The serial port's own errors are
 * DOMExceptions, whose message can't be set: those come back wrapped, as `cause`.
 */
function withDetail(e, detail) {
  try {
    e.message += ` (${detail})`;
    return e;
  } catch (_) {
    return new Error(`${e.message} (${detail})`, { cause: e });
  }
}

/** A lost or corrupted frame: worth resending the request. */
export const isRetriable = e => e instanceof TimeoutError || (e instanceof DeviceError && e.status === STATUS.badFrame);

// Link ///////////////////////////////////////////////////////////////////////

/**
 * One open serial connection to a device in transfer mode.
 *
 * Requests run strictly one at a time. Operations made of several requests
 * (an upload, a download, HELLO which resets the device session) also run one
 * at a time, through `exclusive()`. Device packages extend this class with
 * their own commands.
 */
export class Link {
  /** Use `Link.open(port, device)`. */
  constructor(port, device) {
    this.port = port;
    this.device = device;
    /** Called once when the connection is lost; not on `close()` / `exit()`. */
    this.onclose = null;
    this.closed = false;
    /** The last HELLO result. */
    this.info = null;

    this._rx = new Uint8Array(0);
    this._lastRxMs = 0;
    this._lastTxMs = 0;
    this._seq = 0;
    this._pending = null;
    this._requestLock = Promise.resolve();
    this._opLock = Promise.resolve();
    this._ops = 0;
    this._reader = null;
    this._writer = null;
    this._keepAlive = null;
    this._onSerialDisconnect = e => {
      if (e.target === this.port) this._shutdown(new Error(`${this.device.name} disconnected.`));
    };
  }

  /**
   * Opens the port, retrying while the device is still enumerating. Doesn't talk to it yet.
   * `fresh`: the port just appeared after the switch. On Linux, ModemManager probes a new
   * `ttyACM` for a few seconds and holds it meanwhile, so that gets about 6 s instead of 2 s.
   */
  static async open(port, device, { fresh = false } = {}) {
    const link = new this(port, device);
    const attempts = fresh && isLinux() ? OPEN_ATTEMPTS_LINUX_FRESH : OPEN_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      try {
        await port.open({ baudRate: 115200, bufferSize: 65536 });
        break;
      } catch (e) {
        if (attempt >= attempts) {
          throw new Error(`Can't open the ${link.device.name} serial port. Is another tab or app using it?`
            + (isLinux() ? " On Linux, add your user to the 'dialout' group (or 'uucp' on Arch), then log out and back in, or restart." : ""),
          { cause: e });
        }
        await sleep(250);
      }
    }
    link._writer = port.writable.getWriter();
    link._reader = port.readable.getReader();
    globalThis.navigator?.serial?.addEventListener?.("disconnect", link._onSerialDisconnect);
    link._readLoop();
    return link;
  }

  // Frames ///////////////////////////////////////////////////////////////////

  async _readLoop() {
    try {
      while (this._reader) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value && value.length) this._append(value);
      }
    } catch (e) { /* device went away */ }
    this._shutdown(new Error(`Connection to ${this.device.name} lost.`));
  }

  _append(bytes) {
    const [magic0, magic1] = this.device.magicBytes;
    this._lastRxMs = now();
    const merged = new Uint8Array(this._rx.length + bytes.length);
    merged.set(this._rx);
    merged.set(bytes, this._rx.length);
    this._rx = merged;
    while (this._rx.length >= HEADER_SIZE) {
      // Bytes before a magic are dropped, which also resyncs after garbage
      if (this._rx[0] !== magic0 || this._rx[1] !== magic1) { this._rx = this._rx.subarray(1); continue; }
      const dv = new DataView(this._rx.buffer, this._rx.byteOffset);
      const length = dv.getUint32(4, true);
      if (length > this.device.maxPayload) { this._rx = this._rx.subarray(1); continue; }
      if (this._rx.length < HEADER_SIZE + length) break;
      const frame = this._rx.slice(0, HEADER_SIZE + length);
      this._rx = this._rx.slice(HEADER_SIZE + length);
      const crc = crc32(frame.subarray(HEADER_SIZE), crc32(frame.subarray(2, 8)));
      if (crc !== dv.getUint32(8, true)) {
        this._fail(new DeviceError(STATUS.badFrame, `A reply from ${this.device.name} arrived corrupted. Please retry.`));
        continue;
      }
      this._deliver(frame[2], frame[3], frame.subarray(HEADER_SIZE));
    }
  }

  _deliver(type, seq, payload) {
    const pending = this._pending;
    if (!pending) return;
    if (type === FRAME_ERROR_TYPE) {
      const reason = payload[1] ?? FRAME_ERROR.unknown;
      const text = FRAME_ERROR_TEXT[reason];
      const error = new DeviceError(payload[0] ?? STATUS.badFrame,
        `${this.device.name} received a corrupted request${text ? ` (${text})` : ""}. Please retry.`, payload);
      error.frameError = reason;
      this._fail(error);
      return;
    }
    if (type !== (pending.type | RESPONSE_FLAG) || seq !== pending.seq) return; // a late reply to an abandoned request
    this._pending = null;
    clearInterval(pending.timer);
    pending.resolve(payload);
  }

  /** What had arrived when a request timed out. */
  _rxState() {
    const rx = this._rx;
    if (rx.length < HEADER_SIZE) return `${rx.length} bytes pending`;
    const dv = new DataView(rx.buffer, rx.byteOffset);
    const [magic0, magic1] = this.device.magicBytes;
    const aligned = rx[0] === magic0 && rx[1] === magic1;
    return `${rx.length} of ${HEADER_SIZE + dv.getUint32(4, true)} bytes of a ${aligned ? "" : "misaligned "}frame type 0x${rx[2].toString(16)} seq ${rx[3]} pending`;
  }

  /** Drops partially received data before a retry. */
  _resync() {
    this._rx = new Uint8Array(0);
  }

  _fail(error) {
    const pending = this._pending;
    if (!pending) return;
    this._pending = null;
    clearInterval(pending.timer);
    pending.reject(error);
  }

  _shutdown(error) {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepAlive();
    globalThis.navigator?.serial?.removeEventListener?.("disconnect", this._onSerialDisconnect);
    this._fail(error);
    if (this.onclose) this.onclose(error);
  }

  /** Closes the port without telling the device; `exit()` does both. */
  async close() {
    this.closed = true;
    this.stopKeepAlive();
    globalThis.navigator?.serial?.removeEventListener?.("disconnect", this._onSerialDisconnect);
    this._fail(new Error("Disconnected."));
    const reader = this._reader;
    this._reader = null;
    try { await reader?.cancel(); } catch (e) { /* gone */ }
    try { reader?.releaseLock(); } catch (e) { /* gone */ }
    try { this._writer?.releaseLock(); } catch (e) { /* gone */ }
    try { await this.port.close(); } catch (e) { /* gone */ }
  }

  /**
   * Sends one request and returns the reply payload (status byte included).
   * Throws `DeviceError` for a status other than OK, `TimeoutError` without a reply.
   * `stallMs`: give up early once a reply started arriving and then stopped.
   */
  request(type, payload = new Uint8Array(0), timeout = 5000, stallMs = 0) {
    const run = () => this._send(type, payload, timeout, stallMs);
    const result = this._requestLock.then(run, run);
    this._requestLock = result.catch(() => {});
    return result;
  }

  async _send(type, payload, timeout, stallMs) {
    if (this.closed || !this._writer) throw new Error(`Not connected to ${this.device.name}.`);
    this._seq = (this._seq + 1) & 0xff;
    const seq = this._seq;
    const frame = new Uint8Array(HEADER_SIZE + payload.length);
    const dv = new DataView(frame.buffer);
    [frame[0], frame[1]] = this.device.magicBytes;
    frame[2] = type;
    frame[3] = seq;
    dv.setUint32(4, payload.length, true);
    frame.set(payload, HEADER_SIZE);
    dv.setUint32(8, crc32(payload, crc32(frame.subarray(2, 8))), true);

    const response = new Promise((resolve, reject) => {
      const start = now();
      const timer = setInterval(() => {
        const t = now();
        const stalled = stallMs > 0 && this._rx.length > 0 && t - this._lastRxMs > stallMs;
        if (stalled || t - start > timeout) {
          this._fail(new TimeoutError(`request 0x${type.toString(16)} seq ${seq}: ${this._rxState()}`, this.device.name));
        }
      }, 50);
      this._pending = { type, seq, resolve, reject, timer };
    });
    // The device can reject a frame before the write finishes; it's awaited below
    response.catch(() => {});
    this._lastTxMs = now();
    await this._writer.write(frame);
    const reply = await response;
    if (reply[0] !== STATUS.ok) {
      const status = reply[0];
      throw new DeviceError(status, this.device.statusText[status] || `${this.device.name} error ${status}.`, reply);
    }
    return reply;
  }

  /** Runs `work` with no other operation in between, e.g. a whole upload. */
  exclusive(work) {
    const run = async () => {
      this._ops++;
      try {
        return await work();
      } finally {
        this._ops--;
      }
    };
    const result = this._opLock.then(run, run);
    this._opLock = result.catch(() => {});
    return result;
  }

  /** PINGs while nothing else talks: the device leaves transfer mode after 10 s without a frame. */
  startKeepAlive() {
    this.stopKeepAlive();
    this._keepAlive = setInterval(() => {
      if (this.closed || this._ops > 0 || this._pending) return;
      if (now() - this._lastTxMs < KEEP_ALIVE_MS) return;
      this.request(CMD.ping).catch(() => {});
    }, 500);
  }

  stopKeepAlive() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    this._keepAlive = null;
  }

  // Commands /////////////////////////////////////////////////////////////////

  /** Device info (the device's `parseHello`). Also resets the device session, so it never runs inside another operation. */
  async hello() {
    const p = await this.exclusive(() => this.request(CMD.hello));
    this.info = this.device.parseHello(p);
    return this.info;
  }

  /**
   * Sends one chunk of a chunked write (docs/protocol.md): `payload` is the request,
   * `offset u32` followed by the chunk's `length` bytes; the reply carries the
   * device's offset at byte 4. Resends after a corrupted frame or a lost reply, and
   * tells from the device's offset whether a resent chunk was taken already.
   */
  async writeChunk(type, payload, offset, length, timeout = UPLOAD_DATA_TIMEOUT_MS) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.request(type, payload, timeout);
        return;
      } catch (e) {
        const reply = e instanceof DeviceError ? e.reply : null;
        const deviceOffset = reply && reply.length >= 8 ? new DataView(reply.buffer, reply.byteOffset).getUint32(4, true) : -1;
        const isResendOffset = attempt > 1 && e instanceof DeviceError && e.status === this.device.badOffsetStatus;
        if (isResendOffset && deviceOffset === offset + length) return; // taken, only the reply was lost
        const retriable = isRetriable(e) || (isResendOffset && deviceOffset === offset);
        const detail = `upload at byte ${offset}, attempt ${attempt}: ${e.detail || e.message}`;
        console.warn(`[${this.device.logTag}] ${detail}`);
        if (!retriable || this.closed || attempt > MAX_UPLOAD_RETRIES) {
          throw withDetail(e, detail);
        }
        await sleep(DEVICE_QUIET_MS);
        this._resync();
      }
    }
  }

  /**
   * Reads `length` bytes from `start` with ranged reads (docs/protocol.md): request
   * `offset u32, length u32`, reply data from byte 4. The read size starts at the
   * size that last worked in this browser (at most `maxChunk`) and adapts to lost
   * replies; `start` is sent as is, so the caller aligns it when the device needs that.
   */
  async readRange(type, start, length, maxChunk, options = {}) {
    const { onProgress, signal } = options;
    const key = `${this.device.storageKey}.readChunk`;
    const out = new Uint8Array(length);
    let chunk = loadReadChunk(key, maxChunk);
    let ceiling = chunk; // largest read size not known to fail
    let clean = 0;
    let failures = 0;
    let failuresInRow = 0;
    for (let done = 0; done < length;) {
      signal?.throwIfAborted();
      const size = Math.min(chunk, length - done);
      const args = new Uint8Array(8);
      const dv = new DataView(args.buffer);
      dv.setUint32(0, start + done, true);
      dv.setUint32(4, size, true);
      let p;
      try {
        p = await this.request(type, args, 1500, 300);
      } catch (e) {
        const detail = `read at byte ${start + done}, ${size} bytes: ${e.detail || e.message}`;
        console.warn(`[${this.device.logTag}] ${detail}`);
        failures++;
        if (!isRetriable(e) || this.closed || ++failuresInRow > MAX_READ_FAILURES_IN_ROW) {
          throw withDetail(e, detail);
        }
        this._resync();
        ceiling = Math.max(MIN_READ_CHUNK, chunk >> 1);
        chunk = ceiling;
        clean = 0;
        continue;
      }
      out.set(p.subarray(4, 4 + size), done);
      done += size;
      onProgress?.(done / length);
      failuresInRow = 0;
      clean++;
      if (chunk < ceiling && clean >= GROW_AFTER) {
        chunk = Math.min(ceiling, chunk << 1);
        clean = 0;
      }
      else if (chunk === ceiling && ceiling < maxChunk && clean >= PROBE_AFTER) {
        ceiling = Math.min(maxChunk, ceiling << 1);
        chunk = ceiling;
        clean = 0;
      }
    }
    // Small reads (e.g. headers) say nothing about the size that works
    if (length >= maxChunk) saveReadChunk(key, ceiling);
    if (failures) console.info(`[${this.device.logTag}] ${failures} lost replies, finished with ${chunk} byte reads`);
    return out;
  }

  /** Back to USB MIDI and closes the port. Best effort: the device also leaves after 10 s of silence. */
  async exit() {
    this.stopKeepAlive();
    if (!this.closed) {
      try { await this.request(CMD.exit, undefined, 1000); } catch (e) { /* the timeout takes over */ }
    }
    this.onclose = null;
    await this.close();
  }
}

// Connecting /////////////////////////////////////////////////////////////////

/** Web Serial and Web MIDI are both needed (Chromium-based browsers on desktop). */
export function isSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator && "requestMIDIAccess" in navigator;
}

/** Every serial port this browser has permission for with the device's USB IDs, present while a device is in transfer mode. */
export async function grantedPorts(device) {
  const ports = (await globalThis.navigator?.serial?.getPorts()) ?? [];
  return ports.filter(port => {
    const info = port.getInfo();
    return info.usbVendorId === device.usbVendorId && info.usbProductId === device.usbProductId;
  });
}

/** The first of `grantedPorts`, or null. */
export async function grantedPort(device) {
  return (await grantedPorts(device))[0] ?? null;
}

/* A granted port that wasn't there before: devices share USB IDs, so a port of
another device already in transfer mode isn't taken for this one's. */
async function waitForNewPort(device, before, timeoutMs) {
  const start = now();
  while (now() - start < timeoutMs) {
    const port = (await grantedPorts(device)).find(p => !before.includes(p));
    if (port) return port;
    await sleep(250);
  }
  return null;
}

// Web MIDI's calls have no time limit of their own; on some Windows machines they never settle
const MIDI_ACCESS_MS = 8000;
const MIDI_OPEN_MS = 5000;

function within(promise, ms, message, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout?.(); reject(new Error(message)); }, ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function midiPermission() {
  try {
    return (await navigator.permissions.query({ name: "midi", sysex: true })).state;
  } catch (_) {
    return "unknown";
  }
}

/**
 * Asks the device over USB MIDI to switch to transfer mode and waits for its reply.
 * Both MIDI ports are opened before sending so the reply can't be missed; the
 * request is sent twice at most. A MIDI port that disappears meanwhile means the
 * device switched and only its reply got lost.
 * `onStep` gets a line for each step, for diagnostics.
 */
export async function enterTransferMode(device, { onStep = () => {} } = {}) {
  const name = device.name;
  const hint = portHint();
  const enterSysEx = [0xF0, ...device.sysexSignature, SYSEX_ENTER, 0xF7];
  const replyPrefix = [0xF0, ...device.sysexSignature, SYSEX_REPLY];

  const permission = await midiPermission();
  onStep(`MIDI permission: ${permission}`);
  const asked = now();
  const after = () => `after ${((now() - asked) / 1000).toFixed(1)} s`;
  const request = navigator.requestMIDIAccess({ sysex: true }).catch(e => {
    throw new Error(`MIDI access was denied. ${name} is switched to transfer mode through MIDI SysEx, please allow it.`, { cause: e });
  });
  // A permission prompt waits on the user, so no time limit then
  const access = permission === "prompt" ? await request : await within(request, MIDI_ACCESS_MS,
    `The browser didn't give access to MIDI within ${MIDI_ACCESS_MS / 1000} s. Close other apps and tabs that use MIDI, or try another Chromium-based browser.`,
    // Tells a slow MIDI access from one that never comes
    () => request.then(() => onStep(`MIDI access came late, ${after()}`), e => onStep(`MIDI access failed late, ${after()}: ${e.cause?.message}`)));
  const ports = [...access.inputs.values(), ...access.outputs.values()];
  onStep(`MIDI ports: ${ports.map(p => `${p.type} "${p.name}" (${p.state})`).join(", ") || "none"}`);
  const isDevice = port => device.midiPortName.test(port.name || "");
  const output = [...access.outputs.values()].find(isDevice);
  const inputs = [...access.inputs.values()].filter(isDevice);
  if (!output) throw new MidiPortNotFoundError(name, device.connectHint);

  // Ports left open while the device leaves USB can wedge Chrome's MIDI service on Windows
  // until the browser quits, so they're closed as soon as the reply is in, and on every exit
  let closed = false;
  const closePorts = () => {
    if (closed) return;
    closed = true;
    for (const port of [output, ...inputs]) {
      port.onmidimessage = null;
      Promise.resolve(port.close?.()).catch(() => {});
    }
  };

  try {
    await within(Promise.all([output.open(), ...inputs.map(input => input.open())]), MIDI_OPEN_MS,
      `The MIDI port didn't open within ${MIDI_OPEN_MS / 1000} s.`);
  } catch (e) {
    closePorts();
    throw new Error(`Can't open the ${name} MIDI port.` + hint, { cause: e });
  }

  let status = null;
  let onReply = () => {};
  const replySize = replyPrefix.length + 2;
  const isReply = d => d && d.length === replySize && replyPrefix.every((b, i) => d[i] === b) && d[replySize - 1] === 0xF7;
  for (const input of inputs) {
    input.onmidimessage = e => {
      if (!isReply(e.data)) return;
      status = e.data[replySize - 2];
      closePorts();
      onReply();
    };
  }
  const switched = () => {
    if (output.state !== "disconnected") return false;
    onStep("the MIDI port is gone: the device switched");
    return true;
  };

  try {
    for (let attempt = 0; attempt < 2 && status === null; attempt++) {
      if (switched()) return;
      try {
        onStep(`sending SysEx: enter transfer mode${attempt ? ", again" : ""}`);
        output.send(enterSysEx);
      } catch (e) {
        if (switched()) return;
        throw new Error(`Can't send to the ${name} MIDI port.` + hint, { cause: e });
      }
      // The device may need a while to get ready before it replies (e.g. mount a card)
      await new Promise(resolve => {
        const timer = setTimeout(resolve, device.enterReplyMs[Math.min(attempt, device.enterReplyMs.length - 1)]);
        onReply = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally {
    closePorts();
  }

  if (status === null) {
    if (switched()) return;
    throw new Error(`${name} didn't respond. Its firmware may not support USB transfer.` + hint);
  }
  onStep(`reply: ${status === 0 ? "OK" : status}`);
  if (status !== 0) throw new Error(device.enterText[status] || `${name} refused transfer mode (${status}).`);
}

/**
 * Opens the port and checks HELLO. Resolves to `{ link, info }`, with the keep-alive running.
 * `fresh`: the port just appeared after the switch (see `Link.open`).
 */
export async function handshake(device, port, { onStep = () => {}, fresh = false } = {}) {
  onStep("opening the serial port and sending HELLO");
  const link = await device.Link.open(port, device, { fresh });
  try {
    const info = await link.hello();
    onStep(`HELLO: ${info.firmware ? `firmware ${info.firmware}, ` : ""}protocol ${info.protoMajor}.${info.protoMinor}`);
    if (info.protoMajor !== device.protoMajor) {
      await link.exit();
      throw new ProtocolMismatchError(info.protoMajor, info.protoMinor, device.protoMajor, device.name);
    }
    link.startKeepAlive();
    return { link, info };
  } catch (e) {
    await link.close();
    throw e;
  }
}

/**
 * Connects to the device: reuses a port that's already in transfer mode (e.g. after
 * a reload), otherwise switches the device and waits for its serial port.
 * On first use, once the click that started this has expired, throws
 * `NeedsAuthorizationError`: call `authorizePort()` from a fresh click.
 * `onStep` gets a line for each step, for diagnostics.
 */
export async function connect(device, { onStep = () => {} } = {}) {
  if (!isSupported()) {
    throw new Error("USB transfer needs Web Serial and Web MIDI. Please use a Chromium-based browser (Chrome, Edge, Opera) on macOS, Windows or Linux.");
  }

  const existing = await grantedPorts(device);
  onStep(existing.length ? "serial port already granted to this site" : "no serial port granted to this site yet");
  for (const port of existing) {
    try {
      return await handshake(device, port, { onStep });
    } catch (e) {
      if (e instanceof ProtocolMismatchError) throw e;
      // A stale grant, the device isn't in transfer mode: switch it
      onStep(`no answer on the granted port: ${e.message}`);
    }
  }

  try {
    await enterTransferMode(device, { onStep });
  } catch (e) {
    // Maybe already in transfer mode with a port this browser hasn't been granted yet
    if (e instanceof MidiPortNotFoundError && navigator.userActivation?.isActive) {
      try { return await authorizePort(device, { onStep }); } catch (_) { throw e; }
    }
    throw e;
  }

  onStep("waiting for the serial port");
  const port = await waitForNewPort(device, existing, 2500);
  if (port) return handshake(device, port, { onStep, fresh: true });
  // The click that started this still counts as a user gesture for about 5 s
  if (navigator.userActivation?.isActive) return authorizePort(device, { onStep });
  throw new NeedsAuthorizationError(device.name);
}

/** Shows the browser's port picker, so it must run from a click. The device waits up to 60 s for it. */
export async function authorizePort(device, { onStep = () => {} } = {}) {
  onStep("showing the port picker");
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: device.usbVendorId, usbProductId: device.usbProductId }] });
  return handshake(device, port, { onStep, fresh: true });
}
