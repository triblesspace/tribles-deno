import {
  assert,
  assertArrayIncludes,
  assertEquals,
} from "https://deno.land/std@0.78.0/testing/asserts.ts";
import { v4 } from "https://deno.land/std@0.78.0/uuid/mod.ts";

import { encode } from "https://deno.land/std@0.78.0/encoding/base64.ts";

import {
  id,
  MemTribleDB,
  S3BlobDB,
  TribleBox,
  TribleKB,
  types,
  WSConnector,
} from "../mod.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test({
  name: "Check loopback.",
  fn: async () => {
    // Define a context, mapping between js data and tribles.
    const knightsCtx = {
      [id]: { ...types.uuid },
      name: { id: v4.generate(), ...types.longstring },
      loves: { id: v4.generate(), isLink: true },
      titles: { id: v4.generate(), ...types.shortstring, isMany: true },
    };
    knightsCtx["lovedBy"] = { id: knightsCtx.loves.id, isInverseLink: true };
    // Add some data.

    const kb = new TribleKB(
      new MemTribleDB(),
      new S3BlobDB(
        {
          region: "local",
          accessKeyID: "jeanluc",
          secretKey: "teaearlgreyhot",
          endpointURL: "http://127.0.0.1:9000",
          bucket: "denotest",
        },
      ),
    );

    const knightskb = kb.with(
      knightsCtx,
      (
        [romeo, juliet],
      ) => [
        {
          [id]: romeo,
          name: "Romeo",
          titles: ["fool", "prince"],
          loves: juliet,
        },
        {
          [id]: juliet,
          name: "Juliet",
          titles: ["the lady", "princess"],
          loves: romeo,
        },
      ],
    );
    const knightskb2 = knightskb.with(
      knightsCtx,
      (
        [william],
      ) => [
        {
          [id]: william,
          name: "William",
          titles: ["author"],
        },
      ],
    );

    const inbox = new TribleBox(kb);
    const outbox = new TribleBox(kb);
    const wsCon = new WSConnector("ws://127.0.0.1:8816", inbox, outbox);
    await wsCon.connect();
    outbox.kb = knightskb;
    outbox.kb = knightskb2;

    let slept = 0;
    while (!inbox.kb.equals(outbox.kb) && slept < 1000) {
      await sleep(10);
      slept += 10;
    }
    await wsCon.disconnect();

    assertEquals(
      [...inbox.kb.tribledb.index[0].keys()].map((t) => encode(t)),
      [...outbox.kb.tribledb.index[0].keys()].map((t) => encode(t)),
    );
    assert(inbox.kb.equals(outbox.kb));
  },
  // https://github.com/denoland/deno/issues/7457
});
