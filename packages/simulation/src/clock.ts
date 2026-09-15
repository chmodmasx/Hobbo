import {
  DomainInvariantError,
  addSimTime,
  type SimDuration,
  type SimTime,
} from "@hobbo/domain";

export class WorldClock {
  #now: SimTime;

  constructor(initialTime: SimTime) {
    this.#now = initialTime;
  }

  now(): SimTime {
    return this.#now;
  }

  advanceTo(target: SimTime): SimTime {
    if (target < this.#now) {
      throw new DomainInvariantError(
        `WorldClock cannot move backwards (${target} < ${this.#now})`,
      );
    }

    this.#now = target;
    return this.#now;
  }

  advanceBy(duration: SimDuration): SimTime {
    this.#now = addSimTime(this.#now, duration);
    return this.#now;
  }
}
