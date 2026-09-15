import { DomainInvariantError } from "@hobbo/domain";

const MASK_64 = (1n << 64n) - 1n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_A = 0xbf58476d1ce4e5b9n;
const MIX_B = 0x94d049bb133111ebn;

function u64(value: bigint): bigint {
  return value & MASK_64;
}

/**
 * Small deterministic PRNG stream based on SplitMix64.
 *
 * This is not cryptographic. Its purpose is reproducible simulation and replay.
 * The state is a single unsigned 64-bit integer and can be persisted verbatim.
 */
export class DeterministicRandom {
  #state: bigint;

  constructor(seed: bigint | number | string) {
    const parsed = BigInt(seed);
    this.#state = u64(parsed);
  }

  static fromState(state: bigint | number | string): DeterministicRandom {
    return new DeterministicRandom(state);
  }

  snapshot(): bigint {
    return this.#state;
  }

  nextUint64(): bigint {
    this.#state = u64(this.#state + SPLITMIX_GAMMA);
    let z = this.#state;
    z = u64((z ^ (z >> 30n)) * MIX_A);
    z = u64((z ^ (z >> 27n)) * MIX_B);
    return u64(z ^ (z >> 31n));
  }

  nextFloat(): number {
    // Top 53 bits map exactly into the IEEE-754 integer precision range.
    const value = this.nextUint64() >> 11n;
    return Number(value) / 9_007_199_254_740_992;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new DomainInvariantError(
        "maxExclusive must be a positive safe integer",
      );
    }

    const bound = BigInt(maxExclusive);
    const range = 1n << 64n;
    const rejectionLimit = range - (range % bound);

    while (true) {
      const value = this.nextUint64();
      if (value < rejectionLimit) {
        return Number(value % bound);
      }
    }
  }

  chance(numerator: number, denominator: number): boolean {
    if (
      !Number.isSafeInteger(numerator) ||
      !Number.isSafeInteger(denominator) ||
      denominator <= 0 ||
      numerator < 0 ||
      numerator > denominator
    ) {
      throw new DomainInvariantError(
        "chance requires 0 <= numerator <= denominator using safe integers",
      );
    }

    if (numerator === 0) return false;
    if (numerator === denominator) return true;
    return this.nextInt(denominator) < numerator;
  }
}
