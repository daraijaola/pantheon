import { describe, expect, it } from "vitest";
import { confirmedLevel, type PastCheck } from "../src/policy.ts";

const H = 3_600;
const NOW = 1_791_680_000;
const at = (hoursAgo: number, tier: number, stamps = 0): PastCheck => ({ at: NOW - hoursAgo * H, tier, stamps });

describe("re-check policy (§7.2)", () => {
  it("applies a first link at once", () => {
    expect(confirmedLevel(null, { tier: 3, stamps: 129 }, [], NOW)).toEqual({ tier: 3, stamps: 129 });
  });

  it("downgrades at once, whatever the history", () => {
    expect(confirmedLevel({ tier: 3, stamps: 0b111 }, { tier: 1, stamps: 0b001 }, [at(30, 3, 0b111)], NOW)).toEqual({ tier: 1, stamps: 0b001 });
  });

  it("does not upgrade without a check at least 20 h old", () => {
    expect(confirmedLevel({ tier: 1, stamps: 0 }, { tier: 3, stamps: 0 }, [], NOW).tier).toBe(1);
    expect(confirmedLevel({ tier: 1, stamps: 0 }, { tier: 3, stamps: 0 }, [at(19.9, 3)], NOW).tier).toBe(1);
  });

  it("upgrades once the higher level has held for ≥ 20 h", () => {
    expect(confirmedLevel({ tier: 1, stamps: 0 }, { tier: 3, stamps: 0 }, [at(20, 3)], NOW).tier).toBe(3);
  });

  it("upgrades only as far as every check since then supported", () => {
    expect(confirmedLevel({ tier: 1, stamps: 0 }, { tier: 3, stamps: 0 }, [at(30, 3), at(10, 2)], NOW).tier).toBe(2);
    expect(confirmedLevel({ tier: 1, stamps: 0 }, { tier: 3, stamps: 0 }, [at(30, 3), at(10, 1)], NOW).tier).toBe(1);
  });

  it("cannot be gamed by a balance parked for one check", () => {
    // Big balance only now (and 25 h ago it was small): stays at the on-chain tier.
    expect(confirmedLevel({ tier: 1, stamps: 0 }, { tier: 3, stamps: 0 }, [at(25, 1)], NOW).tier).toBe(1);
  });

  it("drops lost stamps now and adds gained ones only when sustained", () => {
    const onChain = { tier: 2, stamps: 0b0011 };
    expect(confirmedLevel(onChain, { tier: 2, stamps: 0b0110 }, [], NOW).stamps).toBe(0b0010);
    expect(confirmedLevel(onChain, { tier: 2, stamps: 0b0110 }, [at(21, 2, 0b0110)], NOW).stamps).toBe(0b0110);
    expect(confirmedLevel(onChain, { tier: 2, stamps: 0b0110 }, [at(21, 2, 0b0110), at(5, 2, 0b0010)], NOW).stamps).toBe(0b0010);
  });
});
