// Ballots on disk: one JSON file, written whole to a temporary file and renamed into place, so a crash
// never leaves half a file. Each voter has one ballot per round; a newer signature replaces an older one.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ballot } from "./ballot.ts";

type State = { version: 1; ballots: Record<string, Record<string, Ballot>> };

export class Ballots {
  private state: State;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      this.state = JSON.parse(readFileSync(file, "utf8")) as State;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.state = { version: 1, ballots: {} };
    }
  }

  of(round: number): Ballot[] {
    return Object.values(this.state.ballots[round] ?? {});
  }

  get(round: number, voter: string): Ballot | undefined {
    return this.state.ballots[round]?.[voter.toLowerCase()];
  }

  /** Saves a ballot unless the voter already has a newer one. Returns what happened. */
  put(round: number, b: Ballot): "added" | "replaced" | "older" {
    const byVoter = (this.state.ballots[round] ??= {});
    const prev = byVoter[b.voter.toLowerCase()];
    if (prev && prev.signedAt > b.signedAt) return "older";
    byVoter[b.voter.toLowerCase()] = b;
    this.save();
    return prev ? "replaced" : "added";
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state)}\n`);
    renameSync(tmp, this.file);
  }
}
