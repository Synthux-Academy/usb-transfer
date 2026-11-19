// Types for @synthuxacademy/usb-transfer.

/** The parts of a Web Serial `SerialPort` the link uses; a real SerialPort fits. */
export interface SerialPortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

export declare const HEADER_SIZE: 12;
export declare const RESPONSE_FLAG: 0x80;
export declare const FRAME_ERROR_TYPE: 0x80;
export declare const CMD: Readonly<{ hello: 0x01; ping: 0x02; exit: 0x7F }>;
export declare const STATUS: Readonly<{ ok: 0; badFrame: 1; unknownCmd: 2; badState: 3; badArg: 4 }>;
export declare const FIRST_DEVICE_STATUS: 5;
/** Why the device rejected a frame, see `DeviceError.frameError`. */
export declare const FRAME_ERROR: Readonly<{ unknown: 0; crc: 1; stale: 2; overflow: 3; badLength: 4 }>;
export declare const SYSEX_MANUFACTURER: 0x7D;

/** What HELLO returns; a device's `parseHello` adds its own fields. */
export interface HelloInfo {
  protoMajor: number;
  protoMinor: number;
  /** Shown in the connection steps when present */
  firmware?: string;
}

/** `fresh`: the port just appeared after the switch; on Linux, open waits about 6 s for ModemManager instead of 2 s. */
export interface OpenOptions {
  fresh?: boolean;
}

/** What `handshake` needs of a Link class: `open(port, device, options)`. A subclass may ignore `device`. */
export interface LinkClass {
  open(port: SerialPortLike, device: Device<any>, options?: OpenOptions): Promise<Link<any>>;
}

export interface DeviceSpec<I extends HelloInfo = HelloInfo> {
  /** Shown in messages and used to find the MIDI port, e.g. "Spotykach". */
  name: string;
  /** Two ASCII characters starting every frame, e.g. "SK"; also the SysEx signature after 0x7D. */
  magic: string;
  /** The protocol major version this host code speaks; `connect` refuses another one. */
  protoMajor: number;
  /** USB IDs of the serial port in transfer mode. Default 0x0483:0x5740. */
  usbVendorId?: number;
  usbProductId?: number;
  /** Matches the device's USB MIDI port names. Default: the name, ignoring case. */
  midiPortName?: RegExp;
  /** Appended to "<name> MIDI port not found.", e.g. "Is it connected through the rear USB-C port?" */
  connectHint?: string;
  /** Largest reply payload; longer frames are taken for garbage. Default 32784. */
  maxPayload?: number;
  /** Messages per status code, index = code. Codes 0–4 have defaults. */
  statusText?: readonly (string | undefined)[];
  /** Messages per non-zero SysEx enter reply status. */
  enterText?: Readonly<Record<number, string>>;
  /** How long to wait for the SysEx reply, per attempt (two attempts). Default [2000, 3000]. */
  enterReplyMs?: readonly number[];
  /** The device's BAD_OFFSET code, for `writeChunk` to recognise a resent chunk. Default null. */
  badOffsetStatus?: number | null;
  /** HELLO reply payload (status byte first) to info. Default: protoMajor = p[1], protoMinor = p[2]. */
  parseHello?: (payload: Uint8Array) => I;
  /** localStorage key prefix. Default: the name in lower case. */
  storageKey?: string;
  /** Console prefix. Default: the name in lower case. */
  logTag?: string;
  /** The Link subclass `handshake` opens. Default `Link`. */
  Link?: LinkClass;
  /** SysEx signature, default [0x7D, magic[0], magic[1]]. */
  sysexSignature?: readonly number[];
}

export interface Device<I extends HelloInfo = HelloInfo> extends Readonly<Required<Omit<DeviceSpec<I>, "statusText" | "sysexSignature">>> {
  readonly magicBytes: readonly [number, number];
  readonly sysexSignature: readonly number[];
  readonly statusText: readonly string[];
}

export declare function defineDevice<I extends HelloInfo = HelloInfo>(spec: DeviceSpec<I>): Device<I>;

export declare class DeviceError extends Error {
  constructor(status: number, message?: string, reply?: Uint8Array);
  readonly status: number;
  /** The reply payload, status byte first, when the device sent one. */
  readonly reply: Uint8Array | null;
  /** For a frame the device rejected (status badFrame): one of FRAME_ERROR, otherwise null. */
  frameError: number | null;
}
export declare class TimeoutError extends Error {
  constructor(detail: string, deviceName?: string);
  /** What had arrived when the request gave up. */
  readonly detail: string;
}
export declare class NeedsAuthorizationError extends Error {
  constructor(deviceName?: string);
}
export declare class MidiPortNotFoundError extends Error {
  constructor(deviceName?: string, connectHint?: string);
}
export declare class ProtocolMismatchError extends Error {
  constructor(major: number, minor: number, supportedMajor: number, deviceName?: string);
  readonly major: number;
  readonly minor: number;
}

export declare function crc32(data: Uint8Array, crc?: number): number;
/** A lost or corrupted frame: worth resending the request. */
export declare function isRetriable(error: unknown): boolean;

export interface TransferOptions {
  /** 0–1 */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export declare class Link<I extends HelloInfo = HelloInfo> {
  constructor(port: SerialPortLike, device: Device<I>);
  /** Opens the port (retrying while the device enumerates) and returns a link of the class it's called on. */
  static open(port: SerialPortLike, device: Device<any>, options?: OpenOptions): Promise<Link<any>>;
  readonly port: SerialPortLike;
  readonly device: Device<I>;
  /** Called once when the connection is lost; not on `close()` / `exit()`. */
  onclose: ((error: Error) => void) | null;
  closed: boolean;
  /** The last HELLO result. */
  info: I | null;

  /** One request; resolves to the reply payload (status byte first). */
  request(type: number, payload?: Uint8Array, timeout?: number, stallMs?: number): Promise<Uint8Array>;
  /** Runs `work` with no other operation in between. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  startKeepAlive(): void;
  stopKeepAlive(): void;

  hello(): Promise<I>;
  /** One chunk of a chunked write: `payload` = offset u32 + `length` bytes. Retries lost and corrupted frames. */
  writeChunk(type: number, payload: Uint8Array, offset: number, length: number, timeout?: number): Promise<void>;
  /** `length` bytes from `start` through ranged reads, adapting the read size to lost replies. */
  readRange(type: number, start: number, length: number, maxChunk: number, options?: TransferOptions): Promise<Uint8Array>;
  /** Back to USB MIDI, then closes the port. */
  exit(): Promise<void>;
  /** Closes the port without telling the device. */
  close(): Promise<void>;
}

export interface Connection<L extends Link<any> = Link> {
  link: L;
  info: NonNullable<L["info"]>;
}

/** `onStep` gets a line for each connection step, for diagnostics. */
export interface ConnectOptions {
  onStep?: (line: string) => void;
}

export declare function isSupported(): boolean;
export declare function grantedPorts(device: Device<any>): Promise<SerialPortLike[]>;
export declare function grantedPort(device: Device<any>): Promise<SerialPortLike | null>;
export declare function enterTransferMode(device: Device<any>, options?: ConnectOptions): Promise<void>;
export declare function handshake<L extends Link<any> = Link>(device: Device<any>, port: SerialPortLike, options?: ConnectOptions & OpenOptions): Promise<Connection<L>>;
/** Throws `NeedsAuthorizationError` on first use once the click expired; then call `authorizePort()` from a click. */
export declare function connect<L extends Link<any> = Link>(device: Device<any>, options?: ConnectOptions): Promise<Connection<L>>;
export declare function authorizePort<L extends Link<any> = Link>(device: Device<any>, options?: ConnectOptions): Promise<Connection<L>>;
