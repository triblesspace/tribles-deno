import { SEGMENT_SIZE, TRIBLE_SIZE, VALUE_SIZE } from "./trible.js";
import { XXH3_128 } from "./xxh128.js";

//This implementation is limited to keys with 16<= key.length <= 64.

const SESSION_SEED = [...crypto.getRandomValues(new Uint32Array(16))].reduce(
  (acc, v, i) => acc | (BigInt(v) << BigInt(i * 4)),
  0n
);
function PARTHash(key) {
  if (!key.__cached_XXH3_128) {
    key.__cached_XXH3_128 = XXH3_128(key, SESSION_SEED);
  }
  return key.__cached_XXH3_128;
}

const countLeadingZeros = (n) => {
  let count = 0;
  for (let i = 7; 0 <= i; i--) {
    const c = Math.clz32(Number((n >> BigInt(i * 32)) & 0xffffffffn));
    if (c !== 32) return count + c;
    count = count + c;
  }
  return count;
};

const leadingMask = (n) => ~(((1n << BigInt(256 - n)) - 1n) << BigInt(n + 1));

const bitPositions = (n) => {
  const positions = [];
  while (n !== 0n) {
    const p = 255 - countLeadingZeros(n);
    positions.push(p);
    n = n ^ (1n << BigInt(p));
  }
  return positions;
};

const countTrailingZeros = (n) => {
  // count trailing zeros
  n = n | (n << 128n);
  n = n | (n << 64n);
  n = n | (n << 32n);
  n = n | (n << 16n);
  n = n | (n << 8n);
  n = n | (n << 4n);
  n = n | (n << 2n);
  n = n | (n << 1n);
  // 2. Now, inversing the bits reveals the lowest bits
  return 256 - countLeadingZeros(~n);
};

const trailingMask = (n) => ~((1n << BigInt(n)) - 1n);

const makePART = function (KEY_LENGTH, SEGMENT_LENGTH) {
  if (KEY_LENGTH % SEGMENT_LENGTH !== 0) {
    throw Error("Key length must be multiple of segment length.");
  }

  // deno-lint-ignore prefer-const
  let PARTCursor;
  // deno-lint-ignore prefer-const
  let PARTree;
  // deno-lint-ignore prefer-const
  let PARTBatch;
  // deno-lint-ignore prefer-const
  let PARTLeaf;
  // deno-lint-ignore prefer-const
  let PARTNode;

  PARTCursor = class {
    constructor(part) {
      this.part = part;
      this.prefixStack = [0];
      this.infixStack = [0];
      this.orderStack = [];
      this.valid = true;
      this.path = new Uint8Array(KEY_LENGTH);
      this.pathNodes = new Array(KEY_LENGTH + 1);

      if (!part.child) {
        this.valid = false;
        return;
      }
      this.pathNodes[0] = part.child;
    }
    countSubsegment() {
      const prefixLen = this.prefixStack[this.prefixStack.length - 1];
      const node = this.path[prefixLen];
      Math.floor(prefixLen / SEGMENT_LENGTH) <
      Math.floor(node.branchDepth / SEGMENT_LENGTH)
        ? 1
        : node.segmentCount;
    }
    peek() {
      const infixLen = this.infixStack[this.infixStack.length - 1];
      const prefixLen = this.prefixStack[this.prefixStack.length - 1];
      return this.path.slice(prefixLen, prefixLen + infixLen);
    }
    value() {
      const infixLen = this.infixStack[this.infixStack.length - 1];
      const prefixLen = this.prefixStack[this.prefixStack.length - 1];
      return this.pathNodes[prefixLen + infixLen].value;
    }
    next() {
      if (this.valid) {
        const ascending = this.orderStack[this.orderStack.length - 1];
        const prefixLen = this.prefixStack[this.prefixStack.length - 1];
        const infixLen = this.infixStack[this.infixStack.length - 1];
        const searchDepth = prefixLen + infixLen;
        let depth = searchDepth - 1;
        for (; prefixLen <= depth; depth--) {
          let node;
          [this.path[depth], node] = this.pathNodes[depth].seek(
            depth,
            this.path[depth] + (ascending ? +1 : -1),
            ascending
          );
          this.pathNodes[depth + 1] = node;
          if (node) break;
        }
        if (depth < prefixLen) {
          this.valid = false;
          return;
        }
        for (depth++; depth < searchDepth; depth++) {
          [this.path[depth], this.pathNodes[depth + 1]] = this.pathNodes[
            depth
          ].seek(depth, ascending ? 0 : 255, ascending);
        }
      }
    }
    seek(infix) {
      if (this.valid) {
        const ascending = this.orderStack[this.orderStack.length - 1];
        const prefixLen = this.prefixStack[this.prefixStack.length - 1];
        const infixLen = this.infixStack[this.infixStack.length - 1];
        const searchDepth = prefixLen + infixLen;
        let depth = prefixLen;
        search: for (; depth < searchDepth; depth++) {
          const sought = infix[depth - prefixLen];
          let node;
          [this.path[depth], node] = this.pathNodes[depth].seek(
            depth,
            sought,
            ascending
          );
          this.pathNodes[depth + 1] = node;
          if (!node) {
            backtrack: for (depth--; prefixLen <= depth; depth--) {
              let node;
              [this.path[depth], node] = this.pathNodes[depth].seek(
                depth,
                this.path[depth] + (ascending ? +1 : -1),
                ascending
              );
              this.pathNodes[depth + 1] = node;
              if (node) break backtrack;
            }
            if (depth < prefixLen) {
              this.valid = false;
              return false;
            }
            break search;
          }
          if (this.path[depth] !== sought) break search;
        }
        if (depth === searchDepth) {
          return true;
        }
        for (depth++; depth < searchDepth; depth++) {
          [this.path[depth], this.pathNodes[depth + 1]] = this.pathNodes[
            depth
          ].seek(depth, ascending ? 0 : 255, ascending);
        }
        return false;
      }
    }
    push(infixLen, ascending = true) {
      if (infixLen % SEGMENT_LENGTH !== 0) {
        throw Error("Infix length must be multiple of Segment size.");
      }
      const newPrefix =
        this.prefixStack[this.prefixStack.length - 1] +
        this.infixStack[this.infixStack.length - 1];
      if (KEY_LENGTH < newPrefix + infixLen) {
        throw Error("Can't push cursor beyond key length.");
      }
      this.prefixStack.push(newPrefix);
      this.infixStack.push(infixLen);
      this.orderStack.push(ascending);

      for (let depth = newPrefix; depth < newPrefix + infixLen; depth++) {
        [this.path[depth], this.pathNodes[depth + 1]] = this.pathNodes[
          depth
        ].seek(depth, ascending ? 0 : 255, ascending);
      }
    }
    pop() {
      this.orderStack.pop();
      this.prefixStack.pop();
      this.infixStack.pop();
      this.valid = true;
    }
  };

  function _makeNode(children, depth, hash) {
    const owner = {};

    const len = children.length;
    if (len === 0) {
      return null;
    }

    const nchildren = new Array(256);
    let nchildbits = 0n;
    for (let i = 0; i < children.length; i++) {
      const [index, child] = children[i];
      nchildbits = nchildbits | (1n << BigInt(index));
      nchildren[index] = child;
    }
    return new PARTNode(
      children[0].key,
      depth,
      nchildbits,
      nchildren,
      hash,
      1, //TODO segmentCount,
      {}
    );
  }

  function _union(leftNode, rightNode, depth = 0) {
    if (leftNode.hash === rightNode.hash || depth === KEY_LENGTH)
      return leftNode;
    const maxDepth = Math.min(leftNode.branchDepth, rightNode.branchDepth);
    let branchDepth = depth;
    for (; branchDepth < maxDepth; branchDepth++) {
      if (leftNode.key[branchDepth] !== rightNode.key[branchDepth]) break;
    }
    if (branchDepth === KEY_LENGTH) return leftNode;

    const lbits = leftNode.bits(branchDepth);
    const rbits = rightNode.bits(branchDepth);
    const bits = lbits | rbits;
    const commonBits = lbits & rbits;
    const leftBits = lbits & ~rbits;
    const rightBits = ~lbits & rbits;
    const commonPositions = bitPositions(commonBits);
    const leftPositions = bitPositions(leftBits);
    const rightPositions = bitPositions(rightBits);
    const children = new Array(256);
    let segmentCount = 0;
    let hash = 0n;
    for (const pos of leftPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      children[pos] = leftChild;
      hash = hash ^ leftChild.hash;
      segmentCount =
        segmentCount +
        (Math.floor(branchDepth / SEGMENT_LENGTH) <
        Math.floor(leftChild.branchDepth / SEGMENT_LENGTH)
          ? 1
          : leftChild.segmentCount);
    }
    for (const pos of rightPositions) {
      const rightChild = rightNode.get(branchDepth, pos);
      children[pos] = rightChild;
      hash = hash ^ rightChild.hash;
      segmentCount =
        segmentCount +
        (Math.floor(branchDepth / SEGMENT_LENGTH) <
        Math.floor(rightChild.branchDepth / SEGMENT_LENGTH)
          ? 1
          : rightChild.segmentCount);
    }
    for (const pos of commonPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      const rightChild = rightNode.get(branchDepth, pos);
      const union = _union(leftChild, rightChild, branchDepth + 1);
      children[pos] = union;
      hash = hash ^ union.hash;
      segmentCount =
        segmentCount +
        (Math.floor(branchDepth / SEGMENT_LENGTH) <
        Math.floor(union.branchDepth / SEGMENT_LENGTH)
          ? 1
          : union.segmentCount);
    }
    return new PARTNode(
      leftNode.key,
      branchDepth,
      bits,
      children,
      hash,
      segmentCount,
      {}
    );
  }

  function _subtract(leftNode, rightNode, depth = 0) {
    if (leftNode.hash === rightNode.hash || depth === KEY_LENGTH) return null;
    const maxDepth = Math.min(leftNode.branchDepth, rightNode.branchDepth);
    let branchDepth = depth;
    for (; branchDepth < maxDepth; branchDepth++) {
      if (leftNode.key[branchDepth] !== rightNode.key[branchDepth])
        return leftNode;
    }
    if (branchDepth === KEY_LENGTH) return null;

    const lbits = leftNode.bits(branchDepth);
    const rbits = rightNode.bits(branchDepth);
    const leftBits = lbits & ~rbits;
    const commonBits = lbits & rbits;
    const leftPositions = bitPositions(leftBits);
    const commonPositions = bitPositions(commonBits);
    const children = new Array(256);
    let bits = leftBits;
    let segmentCount = 0;
    let hash = 0n;
    for (const pos of leftPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      children[pos] = leftChild;
      hash = hash ^ leftChild.hash;
      segmentCount =
        segmentCount +
        (Math.floor(branchDepth / SEGMENT_LENGTH) <
        Math.floor(leftChild.branchDepth / SEGMENT_LENGTH)
          ? 1
          : leftChild.segmentCount);
    }
    for (const pos of commonPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      const rightChild = rightNode.get(branchDepth, pos);
      const subtraction = _subtract(leftChild, rightChild, branchDepth + 1);
      if (subtraction) {
        bits = bits | (1n << BigInt(pos));
        children[pos] = subtraction;
        hash = hash ^ subtraction.hash;
        segmentCount =
          segmentCount +
          (Math.floor(branchDepth / SEGMENT_LENGTH) <
          Math.floor(subtraction.branchDepth / SEGMENT_LENGTH)
            ? 1
            : subtraction.segmentCount);
      }
    }
    if (bits === 0n) return null;
    return new PARTNode(
      leftNode.key,
      branchDepth,
      bits,
      children,
      hash,
      segmentCount,
      {}
    );
  }

  function _intersect(leftNode, rightNode, depth = 0) {
    if (leftNode.hash === rightNode.hash || depth === KEY_LENGTH)
      return leftNode;
    const maxDepth = Math.min(leftNode.branchDepth, rightNode.branchDepth);
    let branchDepth = depth;
    for (; branchDepth < maxDepth; branchDepth++) {
      if (leftNode.key[branchDepth] !== rightNode.key[branchDepth]) return null;
    }
    if (branchDepth === KEY_LENGTH) return leftNode;

    const lbits = leftNode.bits(branchDepth);
    const rbits = rightNode.bits(branchDepth);
    const commonBits = lbits & rbits;
    const commonPositions = bitPositions(commonBits);
    const children = new Array(256);
    let bits = 0n;
    let segmentCount = 0;
    let hash = 0n;
    for (const pos of commonPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      const rightChild = rightNode.get(branchDepth, pos);
      const intersection = _intersect(leftChild, rightChild, branchDepth + 1);
      if (intersection) {
        bits = bits | (1n << BigInt(pos));
        children[pos] = intersection;
        hash = hash ^ intersection.hash;
        segmentCount =
          segmentCount +
          (Math.floor(branchDepth / SEGMENT_LENGTH) <
          Math.floor(intersection.branchDepth / SEGMENT_LENGTH)
            ? 1
            : intersection.segmentCount);
      }
    }
    if (bits === 0n) return null;
    return new PARTNode(
      leftNode.key,
      branchDepth,
      bits,
      children,
      hash,
      segmentCount,
      {}
    );
  }

  function _difference(leftNode, rightNode, depth = 0) {
    if (leftNode.hash === rightNode.hash || depth === KEY_LENGTH) return null;
    const maxDepth = Math.min(leftNode.branchDepth, rightNode.branchDepth);
    let branchDepth = depth;
    for (; branchDepth < maxDepth; branchDepth++) {
      if (leftNode.key[branchDepth] !== rightNode.key[branchDepth]) break;
    }
    if (branchDepth === KEY_LENGTH) return null;

    const lbits = leftNode.bits(branchDepth);
    const rbits = rightNode.bits(branchDepth);
    const commonBits = lbits & rbits;
    const leftBits = lbits & ~rbits;
    const rightBits = ~lbits & rbits;
    const commonPositions = bitPositions(commonBits);
    const leftPositions = bitPositions(leftBits);
    const rightPositions = bitPositions(rightBits);
    let bits = leftBits | rightBits;
    const children = new Array(256);
    let segmentCount = 0;
    let hash = 0n;
    for (const pos of leftPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      children[pos] = leftChild;
      hash = hash ^ leftChild.hash;
      segmentCount =
        segmentCount +
        (Math.floor(branchDepth / SEGMENT_LENGTH) <
        Math.floor(leftChild.branchDepth / SEGMENT_LENGTH)
          ? 1
          : leftChild.segmentCount);
    }
    for (const pos of rightPositions) {
      const rightChild = rightNode.get(branchDepth, pos);
      children[pos] = rightChild;
      hash = hash ^ rightChild.hash;
      segmentCount =
        segmentCount +
        (Math.floor(branchDepth / SEGMENT_LENGTH) <
        Math.floor(rightChild.branchDepth / SEGMENT_LENGTH)
          ? 1
          : rightChild.segmentCount);
    }
    for (const pos of commonPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      const rightChild = rightNode.get(branchDepth, pos);
      const difference = _difference(leftChild, rightChild, branchDepth + 1);
      if (difference) {
        bits = bits | (1n << BigInt(pos));
        children[pos] = difference;
        hash = hash ^ difference.hash;
        segmentCount =
          segmentCount +
          (Math.floor(branchDepth / SEGMENT_LENGTH) <
          Math.floor(difference.branchDepth / SEGMENT_LENGTH)
            ? 1
            : difference.segmentCount);
      }
    }
    if (bits === 0n) return null;

    return new PARTNode(
      leftNode.key,
      branchDepth,
      bits,
      children,
      hash,
      segmentCount,
      {}
    );
  }
  function _isSubsetOf(leftNode, rightNode, depth = 0) {
    if (leftNode.hash === rightNode.hash || depth === KEY_LENGTH)
      return true;
    const maxDepth = Math.min(leftNode.branchDepth, rightNode.branchDepth);
    let branchDepth = depth;
    for (; branchDepth < maxDepth; branchDepth++) {
      if (leftNode.key[branchDepth] !== rightNode.key[branchDepth]) break;
    }
    if (branchDepth === KEY_LENGTH) return true;

    const lbits = leftNode.bits(branchDepth);
    const rbits = rightNode.bits(branchDepth);
    const leftBits = lbits & ~rbits;
    if(leftBits !== 0n) return false;
    const commonBits = lbits & rbits;
    const commonPositions = bitPositions(commonBits);
    for (const pos of commonPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      const rightChild = rightNode.get(branchDepth, pos);
      const isSubset = _isSubsetOf(leftChild, rightChild, branchDepth + 1);
      if (!isSubset) return false;
    }
    return true;
  }

  function _isIntersecting(leftNode, rightNode, depth = 0) {
    if (leftNode.hash === rightNode.hash || depth === KEY_LENGTH)
      return true;
    const maxDepth = Math.min(leftNode.branchDepth, rightNode.branchDepth);
    let branchDepth = depth;
    for (; branchDepth < maxDepth; branchDepth++) {
      if (leftNode.key[branchDepth] !== rightNode.key[branchDepth]) return false;
    }
    if (branchDepth === KEY_LENGTH) return true;

    const lbits = leftNode.bits(branchDepth);
    const rbits = rightNode.bits(branchDepth);
    const commonBits = lbits & rbits;
    const commonPositions = bitPositions(commonBits);
    for (const pos of commonPositions) {
      const leftChild = leftNode.get(branchDepth, pos);
      const rightChild = rightNode.get(branchDepth, pos);
      const isIntersecting = _isIntersecting(leftChild, rightChild, branchDepth + 1);
      if (isIntersecting) return true;
    }
    return false;
  }

  PARTBatch = class {
    constructor(child) {
      this.child = child;
      this.owner = {};
      this.completed = false;
    }
    complete() {
      if (this.completed) throw Error("Batch already completed.");
      this.completed = true;
      return new PARTree(this.child);
    }
    put(key, value = null) {
      if (this.completed) {
        throw Error("Can't put into already completed batch.");
      }
      if (this.child) {
        this.child = this.child.put(0, key, value, this.owner);
      } else {
        this.child = new PARTLeaf(key, value, PARTHash(key));
      }
      return this;
    }
  };

  PARTree = class {
    constructor(child = null) {
      this.keyLength = KEY_LENGTH;
      this.child = child;
    }
    batch() {
      return new PARTBatch(this.child);
    }

    put(key, value = null) {
      const owner = {};

      if (this.child) {
        const nchild = this.child.put(0, key, value, owner);
        if (this.child === nchild) return this;
        return new PARTree(nchild);
      }
      return new PARTree(new PARTLeaf(key, value, PARTHash(key)));
    }
    get(key) {
      let found;
      let node = this.child;
      if (!node) return undefined;
      for (let depth = 0; depth < KEY_LENGTH; depth++) {
        const sought = key[depth];
        [found, node] = node.seek(depth, sought, true);
        if (!node || found !== sought) return undefined;
      }
      return node.value;
    }

    cursor() {
      return new PARTCursor(this);
    }

    isEmpty() {
      return this.child === null;
    }

    isEqual(other) {
      return (
        this.child === other.child ||
        (this.keyLength === other.keyLength &&
          !!this.child &&
          !!other.child &&
          this.child.hash === other.child.hash)
      );
    }

    isSubsetOf(other) {
      return (
        this.keyLength === other.keyLength &&
        (!this.child || (!!other.child && _isSubsetOf(this.child, other.child)))
      );
    }

    isIntersecting(other) {
      return (
        this.keyLength === other.keyLength &&
        !!this.child &&
        !!other.child &&
        (this.child === other.child ||
          this.child.hash === other.child.hash ||
          _isIntersecting(this.child, other.child))
      );
    }

    union(other) {
      const thisNode = this.child;
      const otherNode = other.child;
      if (thisNode === null) {
        return new PARTree(otherNode);
      }
      if (otherNode === null) {
        return new PARTree(thisNode);
      }
      return new PARTree(_union(thisNode, otherNode));
    }

    subtract(other) {
      const thisNode = this.child;
      const otherNode = other.child;
      if (otherNode === null) {
        return new PARTree(thisNode);
      }
      if (this.child === null || this.child.hash === other.child.hash) {
        return new PARTree();
      } else {
        return new PARTree(_subtract(thisNode, otherNode));
      }
    }

    intersect(other) {
      const thisNode = this.child;
      const otherNode = other.child;

      if (thisNode === null || otherNode === null) {
        return new PARTree(null);
      }
      if (thisNode === otherNode || thisNode.hash === otherNode.hash) {
        return new PARTree(otherNode);
      }
      return new PARTree(_intersect(thisNode, otherNode));
    }

    difference(other) {
      const thisNode = this.child;
      const otherNode = other.child;

      if (thisNode === null) {
        return new PARTree(otherNode);
      }
      if (otherNode === null) {
        return new PARTree(thisNode);
      }
      if (thisNode === otherNode || thisNode.hash === otherNode.hash) {
        return new PARTree(null);
      }
      return new PARTree(_difference(thisNode, otherNode));
    }

    // These are only convenience functions for js interop and no API requirement.
    entries() {
      const cursor = this.cursor();
      if (cursor.valid) cursor.push(KEY_LENGTH);
      return {
        [Symbol.iterator]() {
          return this;
        },
        next() {
          if (!cursor.valid) return { done: true };
          const key = cursor.peek();
          const value = cursor.value();
          cursor.next();
          return { value: [key, value] };
        },
      };
    }

    keys() {
      const cursor = this.cursor();
      if (cursor.valid) cursor.push(KEY_LENGTH);
      return {
        [Symbol.iterator]() {
          return this;
        },
        next() {
          if (!cursor.valid) return { done: true };
          const key = cursor.peek();
          cursor.next();
          return { value: key };
        },
      };
    }

    values() {
      const cursor = this.cursor();
      if (cursor.valid) cursor.push(KEY_LENGTH);
      return {
        [Symbol.iterator]() {
          return this;
        },
        next() {
          if (!cursor.valid) return { done: true };
          const value = cursor.value();
          cursor.next();
          return { value };
        },
      };
    }
  };

  PARTLeaf = class {
    constructor(key, value, hash) {
      this.key = key;
      this.value = value;
      this.hash = hash;
      this.segmentCount = 1;
      this.branchDepth = KEY_LENGTH;
    }
    bits(depth) {
      return 1n << BigInt(this.key[depth]);
    }
    get(depth, v) {
      return this;
    }
    seek(depth, v, ascending) {
      const candidate = this.key[depth];
      if ((ascending && v <= candidate) || (!ascending && v >= candidate)) {
        return [candidate, this];
      }
      return [v, null];
    }
    put(depth, key, value, owner) {
      let branchDepth = depth;
      for (; branchDepth < this.branchDepth; branchDepth++) {
        if (this.key[branchDepth] !== key[branchDepth]) break;
      }

      if (branchDepth === this.branchDepth) {
        return this;
      }

      const nchild = new PARTLeaf(key, value, PARTHash(key));

      const nchildren = new Array(256);
      const lindex = this.key[branchDepth];
      const rindex = key[branchDepth];
      nchildren[lindex] = this;
      nchildren[rindex] = nchild;
      const nchildbits = (1n << BigInt(lindex)) | (1n << BigInt(rindex));
      const segmentCount =
        Math.floor(branchDepth / SEGMENT_LENGTH) <
        Math.floor(this.branchDepth / SEGMENT_LENGTH)
          ? 1
          : this.segmentCount + 1;
      const hash = this.hash ^ nchild.hash;

      return new PARTNode(
        this.key,
        branchDepth,
        nchildbits,
        nchildren,
        hash,
        segmentCount,
        owner
      );
    }
  };

  PARTNode = class {
    constructor(
      key,
      branchDepth,
      childbits,
      children,
      hash,
      segmentCount,
      owner
    ) {
      this.key = key;
      this.branchDepth = branchDepth;
      this.childbits = childbits;
      this.children = children;
      this.hash = hash;
      this.segmentCount = segmentCount;
      this.owner = owner;
    }
    bits(depth) {
      if (depth === this.branchDepth) {
        return this.childbits;
      } else {
        return 1n << BigInt(this.key[depth]);
      }
    }
    get(depth, v) {
      if (depth === this.branchDepth) {
        return this.children[v];
      }
      return this;
    }
    seek(depth, v, ascending) {
      if (depth === this.branchDepth) {
        if (ascending) {
          const zeros = countTrailingZeros(this.childbits & trailingMask(v));
          if (zeros !== 256) {
            return [zeros, this.children[zeros]];
          }
        } else {
          const zeros = countLeadingZeros(this.childbits & leadingMask(v));
          if (zeros !== 256) {
            const pos = 255 - zeros;
            return [pos, this.children[pos]];
          }
        }
      } else {
        const candidate = this.key[depth];
        if ((ascending && v <= candidate) || (!ascending && v >= candidate)) {
          return [candidate, this];
        }
      }
      return [v, null];
    }
    put(depth, key, value, owner) {
      let branchDepth = depth;
      for (; branchDepth < this.branchDepth; branchDepth++) {
        if (this.key[branchDepth] !== key[branchDepth]) break;
      }

      if (branchDepth === this.branchDepth) {
        const pos = key[this.branchDepth];
        const childBit = 1n << BigInt(pos);
        const childDepth = this.branchDepth + 1;
        let nchildbits;
        let nchild;
        let hash;
        let segmentCount;
        if (this.childbits & childBit) {
          const child = this.children[pos];
          nchildbits = this.childbits;
          //We need to update the child where this key would belong.
          nchild = child.put(childDepth, key, value, owner);
          if (child.hash === nchild.hash) return this;
          hash = this.hash ^ child.hash ^ nchild.hash;
          segmentCount =
            Math.floor(this.branchDepth / SEGMENT_LENGTH) <
            Math.floor(child.branchDepth / SEGMENT_LENGTH)
              ? this.segmentCount
              : this.segmentCount - child.segmentCount + nchild.segmentCount;
        } else {
          nchild = new PARTLeaf(key, value, PARTHash(key));
          nchildbits = this.childbits | childBit;
          hash = this.hash ^ nchild.hash;
          segmentCount =
            Math.floor(this.branchDepth / SEGMENT_LENGTH) <
            Math.floor(nchild.branchDepth / SEGMENT_LENGTH)
              ? this.segmentCount + 1
              : this.segmentCount + nchild.segmentCount;
        }
        if (this.owner === owner) {
          this.childbits = nchildbits;
          this.children[pos] = nchild;
          this.hash = hash;
          this.segmentCount = segmentCount;
          return this;
        }
        const nchildren = this.children.slice();
        nchildren[pos] = nchild;
        return new PARTNode(
          this.key,
          this.branchDepth,
          nchildbits,
          nchildren,
          hash,
          segmentCount,
          owner
        );
      }

      const nchild = new PARTLeaf(key, value, PARTHash(key));

      const nchildren = new Array(256);
      const lindex = this.key[branchDepth];
      const rindex = key[branchDepth];
      nchildren[lindex] = this;
      nchildren[rindex] = nchild;
      const nchildbits = (1n << BigInt(lindex)) | (1n << BigInt(rindex));
      const segmentCount =
        Math.floor(branchDepth / SEGMENT_LENGTH) <
        Math.floor(this.branchDepth / SEGMENT_LENGTH)
          ? 1
          : this.segmentCount + 1;
      const hash = this.hash ^ nchild.hash;

      return new PARTNode(
        this.key,
        branchDepth,
        nchildbits,
        nchildren,
        hash,
        segmentCount,
        owner
      );
    }
  };

  return new PARTree();
};

const emptyTriblePART = makePART(TRIBLE_SIZE, SEGMENT_SIZE);
const emptyValuePART = makePART(VALUE_SIZE, SEGMENT_SIZE);
const emptySegmentPART = makePART(SEGMENT_SIZE, SEGMENT_SIZE);

export {
  emptySegmentPART,
  emptyTriblePART,
  emptyValuePART,
  makePART,
  PARTHash,
};
