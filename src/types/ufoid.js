import { UFOID } from "../ufoid.js";

function ufoidEncoder(v, b) {
  if (v === "00000000000000000000000000000000") {
    throw Error("Can't encode NIL UFOID.");
  }
  if (!UFOID.validate(v)) {
    throw Error(`Provided value is not an encodable ufoid:${v.toString()}`);
  }
  b.fill(0, 0, b.length - 16);
  const bytes = new Uint8Array(
    v.match(/.{2}/g).map((hex) => parseInt(hex, 16)),
  );
  b.set(bytes, b.length - 16);
  return null;
}

function ufoidDecoder(b, blob) {
  return [...b.subarray(b.length - 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const ufoid = {
  encoder: ufoidEncoder,
  decoder: ufoidDecoder,
  factory: UFOID.now,
};
