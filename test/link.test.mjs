// js/index.js against cpp/usb_transfer (build/harness, a test device on the internal
// port with a 4 KB chunk) over a fake Web Serial port. Run through run.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  defineDevice, Link, CMD, STATUS, FRAME_ERROR, DeviceError, TimeoutError, crc32, isRetriable,
} from "../js/index.js";

const HARNESS = process.env.HARNESS;
assert.ok(HARNESS, "HARNESS must point to the built harness, use run.sh");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WRITE_BEGIN = 0x10;
const WRITE_DATA = 0x11;
const READ = 0x21;
const BAD_OFFSET = 5;

const TESTBOX = defineDevice({
  name: "Testbox",
  magic: "TB",
  protoMajor: 1,
  maxPayload: 4096 + 16,
  badOffsetStatus: BAD_OFFSET,
  statusText: [, , , , , "Out of sync."],
  parseHello: p => {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    return { protoMajor: p[1], protoMinor: p[2], maxChunk: dv.getUint32(4, true), size: dv.getUint32(8, true) };
  },
});

/*
Starts the device harness and connects a link to it.
fault: harness-side fault (see harness.cpp); onWrite(bytes, write): host-side hook
that may alter or delay a frame on its way to the device.
*/
async function startDevice({ fault, onWrite } = {}) {
  const env = { ...process.env };
  if (fault) env.FAULT = fault;
  const child = spawn(HARNESS, [], { stdio: ["pipe", "pipe", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d; });
  const exited = new Promise(resolve => child.on("exit", code => resolve(code)));

  const queue = [];
  let wake = null;
  let ended = false;
  child.stdout.on("data", d => { queue.push(new Uint8Array(d)); wake?.(); });
  child.stdout.on("end", () => { ended = true; wake?.(); });

  let writes = Promise.resolve();
  const write = bytes => child.stdin.write(Buffer.from(bytes));
  const port = {
    async open() {},
    async close() {},
    readable: {
      getReader: () => ({
        async read() {
          while (!queue.length && !ended) await new Promise(resolve => { wake = resolve; });
          return queue.length ? { value: queue.shift(), done: false } : { done: true };
        },
        async cancel() {},
        releaseLock() {},
      }),
    },
    writable: {
      getWriter: () => ({
        // Web Serial keeps writes in order
        write(bytes) {
          writes = writes.then(() => (onWrite ? onWrite(bytes, write) : write(bytes)));
          return writes;
        },
        releaseLock() {},
      }),
    },
  };

  const link = await Link.open(port, TESTBOX);
  const info = await link.hello();
  return {
    link, info,
    async stop() {
      if (!link.closed) await link.exit();
      const code = await exited;
      assert.equal(code, 0, `harness exited with ${code}: ${stderr}`);
    },
  };
}

function testBlob(size, seed = 1) {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
}

async function writeBlob(link, bytes) {
  const begin = new Uint8Array(4);
  new DataView(begin.buffer).setUint32(0, bytes.length, true);
  await link.request(WRITE_BEGIN, begin);
  const chunk = link.info.maxChunk;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const data = bytes.subarray(offset, offset + chunk);
    const payload = new Uint8Array(4 + data.length);
    new DataView(payload.buffer).setUint32(0, offset, true);
    payload.set(data, 4);
    await link.writeChunk(WRITE_DATA, payload, offset, data.length);
  }
}

// The n-th frame of a given type
function nthFrame(type, n, action) {
  let count = 0;
  return (bytes, write) => (bytes[2] === type && ++count === n ? action(bytes, write) : write(bytes));
}

test("hello, chunked write, ranged read", async () => {
  const device = await startDevice();
  const { link, info } = device;
  assert.deepEqual(info, { protoMajor: 1, protoMinor: 0, maxChunk: 4096, size: 0 });
  const blob = testBlob(50000);
  await writeBlob(link, blob);
  let progress = 0;
  const back = await link.readRange(READ, 0, blob.length, info.maxChunk, { onProgress: p => { progress = p; } });
  assert.deepEqual(back, blob);
  assert.equal(progress, 1);
  assert.deepEqual(await link.readRange(READ, 1234, 10000, info.maxChunk), blob.subarray(1234, 11234));
  assert.equal((await link.hello()).size, blob.length);
  await link.request(CMD.ping);
  await device.stop();
});

for (const [name, options] of [
  ["a corrupted request", { onWrite: nthFrame(WRITE_DATA, 5, (b, write) => { const c = b.slice(); c[2000] ^= 0x55; return write(c); }) }],
  ["a lost reply", { fault: "write-noreply" }],
  ["a request that stalls for 2.5 s", { onWrite: nthFrame(WRITE_DATA, 5, async (b, write) => { write(b.subarray(0, 1000)); await sleep(2500); write(b.subarray(1000)); }) }],
]) {
  test(`chunked write recovers from ${name}`, async () => {
    const device = await startDevice(options);
    const blob = testBlob(40000, 2);
    await writeBlob(device.link, blob);
    assert.deepEqual(await device.link.readRange(READ, 0, blob.length, 4096), blob);
    await device.stop();
  });
}

for (const fault of ["read-cut", "read-drop", "read-burst"]) {
  test(`ranged read recovers from ${fault}`, async () => {
    const device = await startDevice({ fault });
    const blob = testBlob(100000, 3);
    await writeBlob(device.link, blob);
    assert.deepEqual(await device.link.readRange(READ, 0, blob.length, 4096), blob);
    await device.stop();
  });
}

test("statuses: generic texts with the device name, the device's own texts", async () => {
  const device = await startDevice();
  const { link } = device;
  const status = (s, text) => e => e instanceof DeviceError && e.status === s && text.test(e.message);
  await assert.rejects(link.request(0x55), status(STATUS.unknownCmd, /^Testbox doesn't know this command/));
  await assert.rejects(link.request(WRITE_DATA, new Uint8Array(8)), status(STATUS.badState, /^Testbox is busy/));
  await assert.rejects(link.request(READ, new Uint8Array(2)), status(STATUS.badArg, /^Invalid request/));
  const begin = new Uint8Array(4);
  new DataView(begin.buffer).setUint32(0, 1000, true);
  await link.request(WRITE_BEGIN, begin);
  const ahead = new Uint8Array(4 + 10);
  new DataView(ahead.buffer).setUint32(0, 500, true);
  await assert.rejects(link.request(WRITE_DATA, ahead),
    e => status(BAD_OFFSET, /^Out of sync/)(e) && new DataView(e.reply.buffer, e.reply.byteOffset).getUint32(4, true) === 0);
  // HELLO resets the device's session
  await link.hello();
  await assert.rejects(link.request(WRITE_DATA, new Uint8Array(8)), status(STATUS.badState, /busy/));
  await device.stop();
});

test("the device reports why it rejected a frame", async () => {
  let mode = null;
  const device = await startDevice({
    onWrite: async (bytes, write) => {
      if (bytes[2] !== CMD.ping || !mode) return write(bytes);
      const current = mode;
      mode = null;
      if (current === "crc") { const c = bytes.slice(); c[8] ^= 1; return write(c); }
      if (current === "length") { const c = bytes.slice(); new DataView(c.buffer).setUint32(4, 100000, true); return write(c); }
      write(bytes.subarray(0, 6)); // header cut short, then silence
      await sleep(2500);
    },
  });
  const rejected = (reason, text) => e => e.status === STATUS.badFrame && e.frameError === reason && text.test(e.message) && /^Testbox received/.test(e.message);
  mode = "crc";
  await assert.rejects(device.link.request(CMD.ping), rejected(FRAME_ERROR.crc, /checksum/));
  await sleep(250);
  mode = "length";
  await assert.rejects(device.link.request(CMD.ping), rejected(FRAME_ERROR.badLength, /invalid length/));
  await sleep(250);
  mode = "stale";
  await assert.rejects(device.link.request(CMD.ping, undefined, 5000), rejected(FRAME_ERROR.stale, /stopped arriving/));
  await sleep(250);
  await device.link.request(CMD.ping);
  await device.stop();
});

test("garbage on the line and frames of another device are skipped", async () => {
  let first = true;
  const device = await startDevice({
    onWrite: (bytes, write) => {
      if (first && bytes[2] === CMD.ping) {
        first = false;
        write(new TextEncoder().encode("AT\r\nATZ\r\n"));
        const other = bytes.slice();
        other[0] = 0x53; other[1] = 0x4B; // "SK"
        write(other);
      }
      return write(bytes);
    },
  });
  await device.link.request(CMD.ping);
  await device.stop();
});

test("a reply that doesn't come times out with what arrived", async () => {
  const device = await startDevice({ onWrite: nthFrame(CMD.ping, 1, () => {}) });
  await assert.rejects(device.link.request(CMD.ping, undefined, 300),
    e => e instanceof TimeoutError && isRetriable(e) && /^Testbox didn't respond/.test(e.message) && /0 bytes pending/.test(e.detail));
  await device.stop();
});

test("a serial port error keeps its message, with the detail", async () => {
  // Web Serial fails with a DOMException, whose message can't be appended to
  const link = new Link({}, TESTBOX);
  link.request = async () => { throw new DOMException("The device has been lost.", "NetworkError"); };
  await assert.rejects(link.writeChunk(WRITE_DATA, new Uint8Array(8), 4096, 4),
    e => /device has been lost/.test(e.message) && /upload at byte 4096/.test(e.message) && e.cause?.name === "NetworkError");
  await assert.rejects(link.readRange(READ, 0, 4096, 4096),
    e => /device has been lost/.test(e.message) && /read at byte 0/.test(e.message) && e.cause?.name === "NetworkError");
});

test("defineDevice fills in the defaults and checks the required fields", () => {
  assert.equal(TESTBOX.usbVendorId, 0x0483);
  assert.equal(TESTBOX.usbProductId, 0x5740);
  assert.deepEqual(TESTBOX.magicBytes, [0x54, 0x42]);
  assert.deepEqual(TESTBOX.sysexSignature, [0x7D, 0x54, 0x42]);
  assert.ok(TESTBOX.midiPortName.test("TESTBOX MIDI 1"));
  assert.equal(TESTBOX.statusText[5], "Out of sync.");
  assert.equal(TESTBOX.statusText[2], "Testbox doesn't know this command. Update its firmware.");
  assert.equal(TESTBOX.storageKey, "testbox");
  assert.equal(TESTBOX.Link, Link);
  assert.ok(Object.isFrozen(TESTBOX));
  assert.ok(defineDevice({ name: "A (b)", magic: "AB", protoMajor: 1 }).midiPortName.test("a (b)"));
  assert.throws(() => defineDevice({ name: "X", magic: "XYZ", protoMajor: 1 }), /magic/);
  assert.throws(() => defineDevice({ name: "X", magic: "XY" }), /protoMajor/);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xCBF43926);
});
