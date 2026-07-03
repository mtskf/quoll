// Host-only process-table reader for Claude Code terminal detection. Spawns
// `ps` once per handoff (a user-initiated, infrequent action) and hands the
// parsed rows to the pure subtree walk in find-claude-terminal.ts.
//
// POSIX-only (macOS / Linux): on a platform without a compatible `ps`, or on any
// spawn error / timeout / non-zero exit, the promise REJECTS and
// pickClaudeTerminalByProcess falls back to the clipboard path — the process
// pass is a best-effort enhancement over the name match, never a hard
// dependency. Isolated here (the only child_process user) so the detection
// logic stays pure and unit-testable.

import { execFile } from "node:child_process";

import { type ProcInfo, parseProcessTable } from "./find-claude-terminal.js";

/** Read the full process table as `{ pid, ppid, comm }` rows via `ps`. Rejects
 *  on spawn failure / timeout / non-zero exit so the caller can fall back.
 *  `comm=` yields the executable path with the header suppressed; `-ax` lists
 *  every process (not just this session's). */
export function readProcessTable(): Promise<readonly ProcInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,comm="],
      { maxBuffer: 16 * 1024 * 1024, timeout: 3000 },
      (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(parseProcessTable(stdout));
        }
      }
    );
  });
}
