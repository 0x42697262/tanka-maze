/**
 * Transport-neutral binary codec contract. The existing wire module implements
 * concrete snapshot/input packing; this interface lets future transports swap in
 * ArrayBuffer/protobuf-style payloads without coupling gameplay systems to JSON
 * or WebSocket specifics.
 */
export interface BinarySerializer<T> {
  encode(value: T): Uint8Array;
  decode(buffer: ArrayBuffer): T;
}
