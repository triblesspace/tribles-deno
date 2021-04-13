import { emptyValuePACT } from "./pact.js";
import { constantConstraint, indexConstraint, resolve } from "./query.js";
import { A, E, TRIBLE_SIZE, V, VALUE_SIZE } from "./trible.js";

const id = Symbol("id");

class Variable {
  constructor(provider, name = null) {
    this.provider = provider;
    this.name = name;
    this.index = null;
    this.ascending = true;
    this.walked = null;
    this.paths = [];
    this.decoder = null;
  }

  at(index) {
    this.index = index;
    if (
      this.provider.variables[index] &&
      this.provider.variables[index] !== this
    ) {
      throw Error(
        `Same variable position occupied by ${this} and ${
          this.provider.variables[index]
        }`,
      );
    }

    this.provider.variables[index] = this;

    return this;
  }

  ascend() {
    this.ascending = true;
    return this;
  }

  descend() {
    this.ascending = false;
    return this;
  }

  walk(kb) {
    this.walked = kb;
    return this;
  }

  toString() {
    if (this.name) {
      return `${this.name}@${this.index}`;
    }
    return `V:${this.index}`;
  }
}

class VariableProvider {
  constructor() {
    this.variables = [];
    this.unnamedVariables = [];
    this.namedVariables = new Map();
    this.constantVariables = emptyValuePACT;
  }

  namedCache() {
    return new Proxy(
      {},
      {
        get: (_, name) => {
          let v = this.namedVariables.get(name);
          if (v) {
            return v;
          }
          v = new Variable(this, name);
          this.namedVariables.set(name, v);
          return v;
        },
      },
    );
  }

  unnamed() {
    const variable = new Variable(this);
    this.unnamedVariables.push(variable);
    return variable;
  }

  constant(c) {
    let v = this.constantVariables.get(c);
    if (!v) {
      v = new Variable(this);
      v.constant = c;
      this.constantVariables = this.constantVariables.put(c, v);
    }
    return v;
  }

  arrange() {
    let vProbe = 0;
    for (
      const v of [
        ...this.constantVariables.values(),
        ...this.unnamedVariables,
        ...this.namedVariables.values(),
      ]
    ) {
      if (v.index === null) {
        while (this.variables[vProbe]) {
          vProbe++;
        }
        v.index = vProbe;
        this.variables[vProbe] = v;
      }
    }
  }
}

const entityProxy = function entityProxy(kb, ctx, entityId) {
  const attrsBatch = emptyValuePACT.batch();
  const inverseAttrsBatch = emptyValuePACT.batch();
  for (
    const [attr, { id: attrId, isInverse }] of Object.entries(ctx.constraints)
  ) {
    const aId = new Uint8Array(VALUE_SIZE);
    ctx.constraints[id].encoder(attrId, aId);
    let attrs;
    if (isInverse) {
      attrs = inverseAttrsBatch.get(aId);
      if (!attrs) {
        attrs = [];
        inverseAttrsBatch.put(aId, attrs);
      }
    } else {
      attrs = attrsBatch.get(aId);
      if (!attrs) {
        attrs = [];
        attrsBatch.put(aId, attrs);
      }
    }
    attrs.push(attr);
  }
  const attrsById = attrsBatch.complete();
  const inverseAttrsById = inverseAttrsBatch.complete();

  const eId = new Uint8Array(VALUE_SIZE);
  ctx.constraints[id].encoder(entityId, eId);

  const lookup = (o, attr) => {
    const { isInverse, id: attrId } = ctx.constraints[attr];

    const aId = new Uint8Array(VALUE_SIZE);
    ctx.constraints[id].encoder(attrId, aId);

    const res = resolve(
      [
        new constantConstraint(0, eId),
        new constantConstraint(1, aId),
        new kb.tribledb.constraint(...(isInverse ? [2, 1, 0] : [0, 1, 2])),
      ],
      new Set([0, 1, 2]),
      [
        new Uint8Array(VALUE_SIZE),
        new Uint8Array(VALUE_SIZE),
        new Uint8Array(VALUE_SIZE),
      ],
    );

    let result;
    let decoder;
    const { isLink, isUnique, isUniqueInverse } =
      ctx.constraints[ctx.constraints[attr].id];
    if (isLink) {
      decoder = (v, b) =>
        entityProxy(kb, ctx, ctx.constraints[id].decoder(v, b));
    } else {
      decoder = ctx.constraints[attr].decoder;
    }

    if ((!isInverse && isUnique) || (isInverse && isUniqueInverse)) {
      const { done, value } = res.next();
      if (done) return { found: false };
      const [, , v] = value;
      return {
        found: true,
        result: decoder(v.slice(0), async () => await kb.blobdb.get(v)),
      };
    } else {
      return {
        found: true,
        result: [...res].map(([, , v]) =>
          decoder(v.slice(0), async () => await kb.blobdb.get(v))
        ),
      };
    }
  };

  return new Proxy(
    { [id]: entityId },
    {
      get: function (o, attr) {
        if (!(attr in ctx.constraints)) {
          return undefined;
        }

        if (attr in o) {
          return o[attr];
        }

        const { found, result } = lookup(o, attr);
        if (found) {
          Object.defineProperty(o, attr, {
            value: result,
            writable: false,
            configurable: false,
            enumerable: true,
          });
          return result;
        }
        return undefined;
      },
      set: function (_, attr) {
        throw TypeError(
          "Error: Entities are not writable, please use 'with' on the walked KB.",
        );
      },
      has: function (o, attr) {
        if (!(attr in ctx.constraints)) {
          return false;
        }

        const attrId = ctx.constraints[attr].id;
        if (
          attr in o ||
          !ctx.constraints[attrId].isUnique ||
          (ctx.constraints[attr].isInverse &&
            !ctx.constraints[attrId].isUniqueInverse)
        ) {
          return true;
        }
        const aId = new Uint8Array(VALUE_SIZE);
        ctx.constraints[id].encoder(attrId, aId);
        const { done } = resolve(
          [
            constantConstraint(0, eId),
            constantConstraint(1, aId),
            kb.tribledb.constraint(
              ...(
                ctx.constraints[attr].isInverse ? [2, 1, 0] : [0, 1, 2]
              ),
            ),
          ],
          new Set([0, 1, 2]),
          [
            new Uint8Array(VALUE_SIZE),
            new Uint8Array(VALUE_SIZE),
            new Uint8Array(VALUE_SIZE),
          ],
        ).next();
        return !done;
      },
      deleteProperty: function (_, attr) {
        throw TypeError(
          "Error: Entities are not writable, furthermore KBs are append only.",
        );
      },
      setPrototypeOf: function (_) {
        throw TypeError(
          "Error: Entities are not writable and can only be POJOs.",
        );
      },
      isExtensible: function (_) {
        return true;
      },
      preventExtensions: function (_) {
        return false;
      },
      defineProperty: function (_, attr) {
        throw TypeError(
          "Error: Entities are not writable, please use 'with' on the walked KB.",
        );
      },
      getOwnPropertyDescriptor: function (o, attr) {
        if (!(attr in ctx.constraints)) {
          return undefined;
        }

        if (attr in o) {
          return Object.getOwnPropertyDescriptor(o, attr);
        }

        const { found, result } = lookup(o, attr);
        if (found) {
          const property = {
            value: result,
            writable: false,
            configurable: false,
            enumerable: true,
          };
          Object.defineProperty(o, attr, property);
          return property;
        }
        return undefined;
      },
      ownKeys: function (_) {
        const attrs = [id];
        for (
          const [e, a, v] of resolve(
            [
              constantConstraint(0, eId),
              indexConstraint(1, attrsById),
              kb.tribledb.constraint(0, 1, 2),
            ],
            new Set([0, 1, 2]),
            [
              new Uint8Array(VALUE_SIZE),
              new Uint8Array(VALUE_SIZE),
              new Uint8Array(VALUE_SIZE),
            ],
          )
        ) {
          attrs.push(...attrsById.get(a));
        }
        for (
          const [e, a, v] of resolve(
            [
              constantConstraint(0, eId),
              kb.tribledb.constraint(2, 1, 0),
              indexConstraint(1, inverseAttrsById),
            ],
            new Set([0, 1, 2]),
            [
              new Uint8Array(VALUE_SIZE),
              new Uint8Array(VALUE_SIZE),
              new Uint8Array(VALUE_SIZE),
            ],
          )
        ) {
          attrs.push(...inverseAttrsById.get(a));
        }
        return attrs;
      },
    },
  );
};

const isPojo = (obj) => {
  if (obj === null || typeof obj !== "object") {
    return false;
  }
  return Object.getPrototypeOf(obj) === Object.prototype;
};

const entitiesToTriples = (ctx, unknownFactory, root) => {
  const triples = [];
  const work = [];
  const rootIsArray = root instanceof Array;
  const rootIsObject = typeof root === "object" && root !== null;
  if (rootIsArray) {
    for (const [index, entity] of root.entries()) {
      work.push({ path: [index], value: entity });
    }
  } else if (rootIsObject) {
    work.push({ path: [], value: root });
  } else throw Error(`Root must be array of entities or entity, got:\n${root}`);

  while (work.length != 0) {
    const w = work.pop();
    if (
      (!w.parent_id || ctx.constraints[w.parent_attr_id].isLink) &&
      isPojo(w.value)
      // Note: It's tempting to perform more specific error checks here.
      // E.g. catching cases where a change from a cardinality many to a cardinality one
      // still passes an array instead of a POJO.
      // However this is not possible, since the 'id' type is configurable through the context,
      // and with JS being too dynamic to perform an appropriate type check.
      // The cardinality example above might, for instance, use a context in which id's
      // are represented as arrays of numbers. In which case an array be a valid id.
      // And again without knowing the type of the array there is no non-trivial/performant
      // way to distinguish between the byte array of an id, and an entity array.
    ) {
      const entityId = w.value[id] || unknownFactory();
      if (w.parent_id) {
        if (ctx.constraints[w.parent_attr].isInverse) {
          triples.push({
            path: w.path,
            attr: w.parent_attr,
            triple: [entityId, w.parent_attr_id, w.parent_id],
          });
        } else {
          triples.push({
            path: w.path,
            attr: w.parent_attr,
            triple: [w.parent_id, w.parent_attr_id, entityId],
          });
        }
      }
      for (const [attr, value] of Object.entries(w.value)) {
        if (!ctx.constraints[attr]) {
          throw Error(
            `Error at pathBytes [${w.path}]: No attribute named '${attr}' in ctx.`,
          );
        }
        const attr_id = ctx.constraints[attr].id;
        if (!ctx.constraints[attr_id]) {
          throw Error(
            `Error at pathBytes [${w.path}]: No id '${attr_id}' in ctx.`,
          );
        }
        if (
          (!ctx.constraints[attr].isInverse &&
            !ctx.constraints[attr_id].isUnique) ||
          (ctx.constraints[attr].isInverse &&
            !ctx.constraints[attr_id].isUniqueInverse)
        ) {
          if (!(value instanceof Array)) {
            if (ctx.constraints[attr].isInverse) {
              throw Error(
                `Error at pathBytes [${w.path}]: '${attr}' is not unique inverse constrained and needs array.`,
              );
            }
            throw Error(
              `Error at pathBytes [${w.path}]: '${attr}' is not unique constrained and needs array.`,
            );
          }
          for (const [i, v] of value.entries()) {
            work.push({
              path: [...w.path, attr, i],
              value: v,
              parent_id: entityId,
              parent_attr: attr,
              parent_attr_id: attr_id,
            });
          }
        } else {
          work.push({
            path: [...w.path, attr],
            value,
            parent_id: entityId,
            parent_attr: attr,
            parent_attr_id: attr_id,
          });
        }
      }
    } else {
      if (ctx.constraints[w.parent_attr].isInverse) {
        triples.push({
          path: w.path,
          attr: w.parent_attr,
          triple: [w.value, w.parent_attr_id, w.parent_id],
        });
      } else {
        triples.push({
          path: w.path,
          attr: w.parent_attr,
          triple: [w.parent_id, w.parent_attr_id, w.value],
        });
      }
    }
  }
  return triples;
};

const triplesToTribles = function (ctx, triples, tribles = [], blobs = []) {
  for (
    const {
      path,
      attr,
      triple: [entity, attrId, value],
    } of triples
  ) {
    const trible = new Uint8Array(TRIBLE_SIZE);
    const encodedValue = V(trible);
    let blob;
    try {
      const encoder = ctx.constraints[attrId].isLink
        ? ctx.constraints[id].encoder
        : ctx.constraints[attr].encoder;
      if (!encoder) {
        throw Error("No encoder in context.");
      }
      blob = encoder(value, encodedValue);
    } catch (err) {
      throw Error(
        `Error at pathBytes [${path}]:Couldn't encode '${value}' as value for attribute '${attr}':\n${err}`,
      );
    }
    try {
      ctx.constraints[id].encoder(entity, E(trible));
    } catch (err) {
      throw Error(
        `Error at pathBytes [${path}]:Couldn't encode '${entity}' as entity id:\n${err}`,
      );
    }
    try {
      ctx.constraints[id].encoder(attrId, A(trible));
    } catch (err) {
      throw Error(
        `Error at pathBytes [${path}]:Couldn't encode id '${attrId}' of attr '${attr}' in ctx:\n${err}`,
      );
    }

    tribles.push(trible);
    if (blob) {
      blobs.push([encodedValue, blob]);
    }
  }
  return { tribles, blobs };
};

const precompileTriples = (ctx, vars, triples) => {
  const precompiledTriples = [];
  for (
    const {
      path,
      attr,
      triple: [entity, attrId, value],
    } of triples
  ) {
    let entityVar;
    let attrVar;
    let valueVar;

    try {
      if (entity instanceof Variable) {
        if (entity.decoder) {
          if (entity.decoder !== ctx.constraints[id].decoder) {
            throw new Error(
              `Error at paths ${entity.paths} and [${
                path.slice(
                  0,
                  -1,
                )
              }]:\n Variables at positions use incompatible decoders '${entity.decoder.name}' and '${
                ctx[id].decoder.name
              }'.`,
            );
          }
        } else {
          entity.decoder = ctx.constraints[id].decoder;
          entity.paths.push(path.slice(0, -1));
        }
        entityVar = entity;
      } else {
        const b = new Uint8Array(VALUE_SIZE);
        ctx.constraints[id].encoder(entity, b);
        entityVar = vars.constant(b);
      }
    } catch (error) {
      throw Error(
        `Error encoding entity at [${path.slice(0, -1)}]: ${error.message}`,
      );
    }
    try {
      const b = new Uint8Array(VALUE_SIZE);
      ctx.constraints[id].encoder(attrId, b);
      attrVar = vars.constant(b);
    } catch (error) {
      throw Error(
        `Error encoding attribute at [${path.slice}]: ${error.message}`,
      );
    }
    try {
      if (value instanceof Variable) {
        const decoder = ctx.constraints[attrId].isLink
          ? ctx.constraints[id].decoder
          : ctx.constraints[attr].decoder;
        if (!decoder) {
          throw Error("No decoder in context.");
        }
        if (value.decoder) {
          if (value.decoder !== decoder) {
            throw new Error(
              `Error at paths ${value.paths} and [${path}]:\n Variables at positions use incompatible decoders '${value.decoder.name}' and '${decoder.name}'.`,
            );
          }
        } else {
          value.decoder = decoder;
          value.paths.push([...path]);
        }
        valueVar = value;
      } else {
        const encoder = ctx.constraints[attrId].isLink
          ? ctx.constraints[id].encoder
          : ctx.constraints[attr].encoder;
        if (!encoder) {
          throw Error("No encoder in context.");
        }
        const b = new Uint8Array(VALUE_SIZE);
        encoder(value, b);
        valueVar = vars.constant(b);
      }
    } catch (error) {
      throw Error(`Error encoding value at [${path}]: ${error.message}`);
    }
    precompiledTriples.push([entityVar, attrVar, valueVar]);
  }

  return precompiledTriples;
};

function* find(ctx, cfn, blobdb) {
  const vars = new VariableProvider();
  const constraintBuilderPrepares = cfn(vars.namedCache());
  const constraintBuilders = constraintBuilderPrepares.map((prepare) =>
    prepare(ctx, vars)
  );
  vars.arrange();

  const variableCount = vars.variables.length;
  const namedVariables = [...vars.namedVariables.values()];

  const constraints = constraintBuilders.flatMap((builder) => builder());
  constraints.push(
    ...[...vars.constantVariables.values()].map(
      (v) => constantConstraint(v.index, v.constant),
    ),
  );

  for (
    const r of resolve(
      constraints,
      new Set(vars.variables.filter((v) => v.ascending).map((v) => v.index)),
      vars.variables.map((v) => new Uint8Array(VALUE_SIZE)),
    )
  ) {
    yield Object.fromEntries(
      namedVariables.map(({ index, walked, decoder, name }) => {
        const encoded = r[index];
        const decoded = decoder(
          encoded.slice(0),
          async () => await blobdb.get(encoded),
        );
        return [name, walked ? walked.walk(ctx, decoded) : decoded];
      }),
    );
  }
}

class IDSequence {
  constructor(factory) {
    this.factory = factory;
  }

  [Symbol.iterator]() {
    return this;
  }
  next() {
    return { value: this.factory() };
  }
}

class TribleKB {
  constructor(ctx, tribledb, blobdb) {
    this.ctx = ctx;
    this.tribledb = tribledb;
    this.blobdb = blobdb;
  }

  withTribles(tribles) {
    const tribledb = this.tribledb.with(tribles);
    if (tribledb === this.tribledb) {
      return this;
    }
    return new TribleKB(this.ctx, tribledb, this.blobdb);
  }

  with(efn) {
    const idFactory = this.ctx.constraints[id].factory;
    const entities = efn(new IDSequence(idFactory));
    const triples = entitiesToTriples(this.ctx, idFactory, entities);
    const { tribles, blobs } = triplesToTribles(this.ctx, triples);
    //const touchedEntities = tribles.map((t) => E(t));
    const newTribleDB = this.tribledb.with(tribles);
    if (newTribleDB !== this.tribledb) {
      /* TODO finish up constraint checking
      for (
        const [e, a, v] of resolve(
          [
            indexConstraint(0, touchedEntities),
            indexConstraint(1, this.ctx.uniqueAttributes),
            newTribleDB.constraint(0, 1, 2),
          ],
          new Set([0, 1, 2]),
          [new Uint8Array(VALUE_SIZE), new Uint8Array(VALUE_SIZE), new Uint8Array(VALUE_SIZE)]
        )
      ) {
        attrs.push(...attrsById.get(a));
      }
      */

      const newBlobDB = this.blobdb.put(blobs);
      return new TribleKB(this.ctx, newTribleDB, newBlobDB);
    }
    return this;
  }

  find(efn) {
    return find(this.ctx, (vars) => [this.where(efn(vars))], this.blobdb);
  }

  where(entities) {
    return (ctx, vars) => {
      const triples = entitiesToTriples(ctx, () => vars.unnamed(), entities);
      const triplesWithVars = precompileTriples(ctx, vars, triples);
      return () => [
        ...triplesWithVars.map(
          ([{ index: e }, { index: a }, { index: v }]) =>
            this.tribledb.constraint(e, a, v),
        ),
      ];
    };
  }

  walk(entityId) {
    return entityProxy(this, this.ctx, entityId);
  }

  empty() {
    return new TribleKB(this.tribledb.empty(), this.blobdb.empty());
  }

  isEmpty() {
    return this.tribledb.isEmpty();
  }

  isEqual(other) {
    return (
      this.tribledb.isEqual(other.tribledb) && this.blobdb.isEqual(other.blobdb)
    );
  }

  isSubsetOf(other) {
    return this.tribledb.isSubsetOf(other.tribledb);
  }

  isIntersecting(other) {
    return this.tribledb.isIntersecting(other.tribledb);
  }

  union(other) {
    const tribledb = this.tribledb.union(other.tribledb);
    const blobdb = this.blobdb.merge(other.blobdb);
    return new TribleKB(ctx(this.ctx, other.ctx), tribledb, blobdb);
  }

  subtract(other) {
    const tribledb = this.tribledb.subtract(other.tribledb);
    const blobdb = this.blobdb.merge(other.blobdb).shrink(tribledb);
    return new TribleKB(this.ctx, tribledb, blobdb);
  }

  difference(other) {
    const tribledb = this.tribledb.difference(other.tribledb);
    const blobdb = this.blobdb.merge(other.blobdb).shrink(tribledb);
    return new TribleKB(ctx(this.ctx, other.ctx), tribledb, blobdb);
  }

  intersect(other) {
    const tribledb = this.tribledb.intersect(other.tribledb);
    const blobdb = this.blobdb.merge(other.blobdb).shrink(tribledb);
    return new TribleKB(this.ctx, tribledb, blobdb);
  }
}

const ctx = (...ctxs) => {
  //TODO simply return first context if all contexts are equal.
  const outCtx = { ns: {}, constraints: {} };
  for (const { ns, constraints } of ctxs) {
    for (const [id, novel] of Object.entries(constraints)) {
      const existing = outCtx.constraints[id];
      if (existing) {
        if (Boolean(existing.isLink) !== Boolean(novel.isLink)) {
          throw Error(
            `Inconsistent ctx id "${id}": isLink:${existing.isLink} !== isLink:${novel.isLink}`,
          );
        }
        if (Boolean(existing.isUnique) !== Boolean(novel.isUnique)) {
          throw Error(
            `Inconsistent ctx id "${id}": isUnique:${existing.isUnique} !== isUnique:${novel.isUnique}`,
          );
        }
        if (
          Boolean(existing.isUniqueInverse) !== Boolean(novel.isUniqueInverse)
        ) {
          throw Error(
            `Inconsistent ctx id "${id}": isUniqueInverse:${existing.isUniqueInverse} !== isUniqueInverse:${novel.isUniqueInverse}`,
          );
        }
      } else {
        outCtx.constraints[id] = novel;
      }
    }
  }
  for (const { ns, constraints } of ctxs) {
    if (ns[id]) outCtx.constraints[id] = ns[id]; //TODO in tribles check consistency of encoder/decoder
    for (const [name, novel] of Object.entries(ns)) {
      const existing = outCtx.constraints[name];
      if (existing) {
        if (existing.id !== novel.id) {
          throw Error(
            `Inconsistent ctx attr "${name}": id:${existing.id} !== id:${novel.id}`,
          );
        }
        if (Boolean(existing.isInverse) !== Boolean(novel.isInverse)) {
          throw Error(
            `Inconsistent ctx attr "${name}": isInverse:${existing.isInverse} !== isInverse:${novel.isInverse}`,
          );
        }
        if (existing.decoder !== novel.decoder) {
          throw Error(
            `Inconsistent ctx attr "${name}": decoder:${existing.decoder} !== decoder:${novel.decoder}`,
          );
        }
        if (existing.encoder !== novel.encoder) {
          throw Error(
            `Inconsistent ctx attr "${name}": encoder:${existing.decoder} !== encoder:${novel.decoder}`,
          );
        }
      } else {
        if (!outCtx.constraints[novel.id]) {
          throw Error(
            `Inconsistent ctx: No id ${novel.id} in context for ${name}.`,
          );
        }
        if (novel.isInverse && !outCtx.constraints[novel.id].isLink) {
          throw Error(
            `Inconsistent ctx attr "${name}": Only links can be inverse.`,
          );
        }
        if (!(novel.decoder || outCtx.constraints[novel.id].isLink)) {
          throw Error(`Invalid ctx attr: No decoder in context for ${name}.`);
        }
        if (!(novel.encoder || outCtx.constraints[novel.id].isLink)) {
          throw Error(`Invalid ctx attr: No encoder in context for ${name}.`);
        }
        outCtx.constraints[name] = novel;
      }
    }
  }
  if (!outCtx.constraints[id]) {
    throw Error(`Incomplete ctx: Missing [id] field in ns.`);
  }
  if (!outCtx.constraints[id].decoder) {
    throw Error(`Incomplete ctx: Missing [id] decoder in ns.`);
  }
  if (!outCtx.constraints[id].encoder) {
    throw Error(`Incomplete ctx: Missing [id] encoder in ns.`);
  }
  if (!outCtx.constraints[id].factory) {
    throw Error(`Incomplete ctx: Missing [id] factory in ns.`);
  }
  return outCtx;
};

export { ctx, find, id, TribleKB };
