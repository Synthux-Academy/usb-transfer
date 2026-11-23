// Switching to transfer mode over a fake Web MIDI, with mocked timers, and picking
// the serial port. Run through run.sh.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { defineDevice, enterTransferMode, connect, crc32, Link, MidiPortNotFoundError } from "../js/index.js";

const TESTBOX = defineDevice({ name: "Testbox", magic: "TB", protoMajor: 1, connectHint: "Is it plugged in?" });
const REPLY_OK = [0xF0, 0x7D, 0x54, 0x42, 0x02, 0, 0xF7];

const never = new Promise(() => {});
const flush = () => new Promise(setImmediate);

function fakeNavigator({ permission = "granted", access = Promise.resolve(midiAccess([])), serial } = {}) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { permissions: { query: async () => ({ state: permission }) }, requestMIDIAccess: () => access, serial },
  });
}

function midiAccess(ports) {
  const map = type => new Map(ports.filter(p => p.type === type).map((p, i) => [i, p]));
  return { inputs: map("input"), outputs: map("output") };
}

const devicePort = (type, open = async () => {}) => ({
  type, name: "Testbox", state: "connected", open, send() {},
  closed: 0,
  async close() { this.closed++; },
});

// A serial port answering HELLO like a Testbox with protocol 1.0
function helloPort() {
  const queue = [];
  let wake = null;
  return {
    getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }),
    async open() {},
    async close() {},
    readable: {
      getReader: () => ({
        async read() {
          while (!queue.length) await new Promise(resolve => { wake = resolve; });
          return { value: queue.shift(), done: false };
        },
        async cancel() {},
        releaseLock() {},
      }),
    },
    writable: {
      getWriter: () => ({
        async write(request) {
          const payload = new Uint8Array([0, 1, 0]);
          const frame = new Uint8Array(12 + payload.length);
          const dv = new DataView(frame.buffer);
          frame.set([0x54, 0x42, request[2] | 0x80, request[3]]);
          dv.setUint32(4, payload.length, true);
          frame.set(payload, 12);
          dv.setUint32(8, crc32(payload, crc32(frame.subarray(2, 8))), true);
          queue.push(frame);
          wake?.();
        },
        releaseLock() {},
      }),
    },
  };
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

test("MIDI access that never comes times out", async () => {
  fakeNavigator({ access: never });
  const result = assert.rejects(enterTransferMode(TESTBOX), /didn't give access to MIDI within 8 s/);
  await flush();
  mock.timers.tick(8000);
  await result;
});

test("no time limit while the permission prompt is open", async () => {
  let grant;
  fakeNavigator({ permission: "prompt", access: new Promise(resolve => { grant = resolve; }) });
  const result = assert.rejects(enterTransferMode(TESTBOX), e => e instanceof MidiPortNotFoundError
    && e.message === "Testbox MIDI port not found. Is it plugged in?");
  await flush();
  mock.timers.tick(60000);
  grant(midiAccess([]));
  await result;
});

test("a MIDI port that never opens times out", async () => {
  fakeNavigator({ access: Promise.resolve(midiAccess([devicePort("output", () => never), devicePort("input")])) });
  const result = assert.rejects(enterTransferMode(TESTBOX),
    e => /Can't open the Testbox MIDI port/.test(e.message) && /within 5 s/.test(e.cause.message));
  await flush();
  mock.timers.tick(5000);
  await result;
});

test("ports are closed when one of them doesn't open", async () => {
  const output = devicePort("output", () => never);
  const input = devicePort("input");
  fakeNavigator({ access: Promise.resolve(midiAccess([output, input])) });
  const result = assert.rejects(enterTransferMode(TESTBOX), /Can't open the Testbox MIDI port/);
  await flush();
  mock.timers.tick(5000);
  await result;
  assert.deepEqual([output.closed, input.closed], [1, 1]);
});

test("ports are closed as soon as the reply arrives, before the device leaves USB", async () => {
  const input = devicePort("input");
  let closedAtReply;
  let sent;
  const reply = () => {
    input.onmidimessage({ data: REPLY_OK });
    closedAtReply = [output.closed, input.closed];
  };
  const output = { ...devicePort("output"), send: data => { sent = data; queueMicrotask(reply); } };
  fakeNavigator({ access: Promise.resolve(midiAccess([input, output])) });
  await enterTransferMode(TESTBOX);
  assert.deepEqual(sent, [0xF0, 0x7D, 0x54, 0x42, 0x01, 0xF7]);
  assert.deepEqual(closedAtReply, [1, 1]);
  assert.deepEqual([output.closed, input.closed], [1, 1]);
  assert.equal(input.onmidimessage, null);
});

test("another device's reply is ignored, a refusal names the device's reason", async () => {
  const device = defineDevice({ name: "Testbox", magic: "TB", protoMajor: 1, enterText: { 1: "Testbox is recording." } });
  const input = devicePort("input");
  const output = {
    ...devicePort("output"),
    send: () => queueMicrotask(() => {
      input.onmidimessage({ data: [0xF0, 0x7D, 0x53, 0x4B, 0x02, 0, 0xF7] });
      input.onmidimessage({ data: [0xF0, 0x7D, 0x54, 0x42, 0x02, 1, 0xF7] });
    }),
  };
  fakeNavigator({ access: Promise.resolve(midiAccess([input, output])) });
  await assert.rejects(enterTransferMode(device), /^Error: Testbox is recording\.$/);
});

test("ports are closed when the device doesn't reply", async () => {
  const input = devicePort("input");
  const output = devicePort("output");
  fakeNavigator({ access: Promise.resolve(midiAccess([input, output])) });
  const result = assert.rejects(enterTransferMode(TESTBOX), /Testbox didn't respond/);
  await flush();
  mock.timers.tick(2000);
  await flush();
  mock.timers.tick(3000);
  await result;
  assert.deepEqual([output.closed, input.closed], [1, 1]);
});

test("each step of a switch is reported", async () => {
  const input = devicePort("input");
  const reply = () => input.onmidimessage({ data: REPLY_OK });
  const output = { ...devicePort("output"), send: () => queueMicrotask(reply) };
  fakeNavigator({ access: Promise.resolve(midiAccess([input, output])) });
  const steps = [];
  await enterTransferMode(TESTBOX, { onStep: line => steps.push(line) });
  assert.deepEqual(steps, [
    "MIDI permission: granted",
    'MIDI ports: input "Testbox" (connected), output "Testbox" (connected)',
    "sending SysEx: enter transfer mode",
    "reply: OK",
  ]);
});

test("a MIDI access that comes after the time limit is reported", async () => {
  let grant;
  fakeNavigator({ access: new Promise(resolve => { grant = resolve; }) });
  const steps = [];
  const result = assert.rejects(enterTransferMode(TESTBOX, { onStep: line => steps.push(line) }), /within 8 s/);
  await flush();
  mock.timers.tick(8000);
  await result;
  grant(midiAccess([]));
  await flush();
  assert.match(steps.at(-1), /^MIDI access came late, after \d+\.\d s$/);
});

test("connect takes the port that appears after the switch, not another device's", async () => {
  mock.timers.reset(); // real timers: the other port's open retries take about 2 s
  // Another device with the same USB IDs, already in transfer mode: its port doesn't open for us
  const other = { getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }), open: async () => { throw new Error("busy"); } };
  const ours = helloPort();
  let ports = [other];
  const input = devicePort("input");
  const output = {
    ...devicePort("output"),
    send: () => queueMicrotask(() => { ports = [other, ours]; input.onmidimessage({ data: REPLY_OK }); }),
  };
  fakeNavigator({ access: Promise.resolve(midiAccess([input, output])), serial: { getPorts: async () => ports } });
  const steps = [];
  const { link, info } = await connect(TESTBOX, { onStep: line => steps.push(line) });
  await link.close();
  assert.equal(link.port, ours);
  assert.deepEqual(info, { protoMajor: 1, protoMinor: 0 });
  assert.ok(steps.some(line => /no answer on the granted port: Can't open the Testbox serial port/.test(line)), steps.join("\n"));
  assert.equal(steps.at(-1), "HELLO: protocol 1.0");
});

// Opens a port that stays busy for `busyMs`, with mocked timers; resolves to the Link or the error.
async function openBusy(busyMs, options) {
  let elapsed = 0;
  const port = { ...helloPort(), async open() { if (elapsed < busyMs) throw new Error("busy"); } };
  let result = null;
  const done = Link.open(port, TESTBOX, options).then(link => (result = link), e => (result = e));
  while (!result) {
    await flush();
    mock.timers.tick(250);
    elapsed += 250;
  }
  await done;
  return result;
}

test("on Linux a port that just appeared gets about 6 s to open, past a ModemManager probe", async () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
  });
  const fresh = await openBusy(4000, { fresh: true });
  assert.ok(fresh instanceof Link, String(fresh));
  await fresh.close();
  // A port that was already granted keeps 2 s, so a busy one doesn't hold up the switch
  const granted = await openBusy(4000);
  assert.match(granted.message, /Can't open the Testbox serial port.*'dialout'/);
  // Elsewhere, 2 s either way
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" } });
  const mac = await openBusy(4000, { fresh: true });
  assert.match(mac.message, /^Can't open the Testbox serial port\. Is another tab or app using it\?$/);
});
