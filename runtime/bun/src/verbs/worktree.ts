// Native `tap worktree` (tap-fni3j R12 U1): ports the deleted tap-worktree.sh.
// The verdict contract and the fail-closed query ruling live in
// docs/solutions/best-practices/worktree-gc-guidelines.md.
// skills/drive/references/worktree-gc.md is the operational floor.
// Branch-backed completion requires
// PR corroboration before preservation may decide (tap-dg8g).
//
// tap-xw1tx: `check` and `branch` are separate questions. `check` reclaim
// licenses `git worktree remove` only. `branch` is its own subcommand, not a
// flag on `check`, so a caller cannot turn checkout reclaim into permission
// to delete a branch by dropping a flag. `branch` keeps completion
// (corroborated PR MERGED/CLOSED) and refuses a detached HEAD. Its
// preservation is the PR headRefOid or a listed PR commit containing the
// branch tip, or content already on origin/main. A local remote-tracking
// ref is not that proof. Checkout removal still uses remote-tracking
// containment.
// A flag would still print `reclaim`; the subcommand is the only stdout that
// names a branch and the commit to delete. The delete is
// `git update-ref -d refs/heads/<branch> <oid>`, so a moved ref fails closed.
// `main`, `master`, and the remote default branch refuse. Weakening branch-backed checkout reclaim waits
// for the tap-tv2jy ephemeral-review marker.
//
// Verdict order is deliberate: identity refusals BEFORE state holds BEFORE
// evidence. Exit 0 every path reclaim / 2 any non-reclaim / 1 usage.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

import { TapError } from "../context";
import { physicalPath } from "../clear-fence";
import { ensureAscii } from "../fsatomic";
import { globalRegistryPath, isRegularFile, readIndexJson } from "../index-home";
import { teamRegistryRefusal } from "../register-authority";
import { REGISTRY_MAX_BUFFER, spawnOutcome } from "../spawn";

const USAGE = "tap help worktree";
const USAGE_LINE = "usage: tap worktree check <path>... [--json]\n       tap worktree branch <path>... [--json]";

type Question = "checkout" | "branch";
type Verdict = "reclaim" | "keep" | "hold" | "refuse";
interface Row { verdict: Verdict; path: string; evidence: string; branch?: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function usageError(detail: string): TapError {
  return new TapError(1, "usage_error", USAGE, detail);
}

// One git child in the target worktree. `unusable` (could not run, killed,
// ENOBUFS) is failure — it never counts as a successful query.
function checkedOutElsewhere(target: string, branchName: string): "elsewhere" | "only-here" | "unreadable" {
  const listed = git(target, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return "unreadable";
  const here = physicalPath(target);
  let current = "";
  let elsewhere = false;
  for (const line of listed.out.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (current !== "" && line === `branch refs/heads/${branchName}` && physicalPath(current) !== here) elsewhere = true;
  }
  return elsewhere ? "elsewhere" : "only-here";
}

function git(path: string, args: string[]): { code: number; out: string; ok: boolean } {
  const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", maxBuffer: REGISTRY_MAX_BUFFER });
  const ok = spawnOutcome(r) === "ran";
  return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), ok };
}

export function cmdWorktree(argv: string[]): number {
  const sub = argv[0] ?? "";
  if (sub !== "check" && sub !== "branch") {
    throw usageError(sub === "" || sub === "-h" || sub === "--help" ? USAGE_LINE : `unknown subcommand '${sub}'`);
  }
  const question: Question = sub === "branch" ? "branch" : "checkout";
  const paths: string[] = [];
  let json = false;
  // The shared renderer reads TAP_JSON. Recognize the flag before any usage
  // throw so a missing path, or a bad flag on either side of --json, is the
  // JSON envelope rather than a human line on stderr.
  if (argv.slice(1).includes("--json")) process.env.TAP_JSON = "1";
  for (const arg of argv.slice(1)) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("-")) throw usageError(`unknown flag '${arg}'`);
    else paths.push(arg);
  }
  if (paths.length === 0) throw usageError("need at least one path");

  const rows: Row[] = paths.map(target => checkPath(target, question));
  writeRows(rows, json, question);
  return rows.every(row => row.verdict === "reclaim") ? 0 : 2;
}

function writeRows(rows: Row[], json: boolean, question: Question): void {
  if (json) {
    // ensureAscii matches python json.dumps ensure_ascii=True byte for byte.
    // check omits branch so existing consumers keep verdict/path/evidence.
    const results = question === "branch"
      ? rows.map(row => ({ verdict: row.verdict, path: row.path, branch: row.branch ?? "", evidence: row.evidence }))
      : rows.map(row => ({ verdict: row.verdict, path: row.path, evidence: row.evidence }));
    process.stdout.write(`${ensureAscii(JSON.stringify({ ok: true, results }))}\n`);
    return;
  }
  for (const row of rows) {
    if (question === "branch") process.stdout.write(`${row.verdict}\t${row.path}\t${row.branch ?? ""}\t${row.evidence}\n`);
    else process.stdout.write(`${row.verdict}\t${row.path}\t${row.evidence}\n`);
  }
}

function checkPath(target: string, question: Question): Row {
  // The branch field is the deletion target, and only a reclaim row carries one.
  // keep/hold/refuse leave it empty so a third-field read is not a branch name.
  let branch = "";
  let tip = "";
  let earlyBranch = "";
  const row = (verdict: Verdict, evidence: string): Row => (
    question === "branch"
      ? { verdict, path: target, branch: "", evidence }
      : { verdict, path: target, evidence }
  );
  const reclaimBranch = (evidence: string): Row => (
    question === "branch"
      ? { verdict: "reclaim", path: target, branch, evidence: `branch ${branch} may be deleted at ${tip}: ${evidence}` }
      : { verdict: "reclaim", path: target, evidence }
  );
  try {
    if (!statSync(target).isDirectory()) throw new Error();
  } catch {
    return row("refuse", "no such directory");
  }
  if (!git(target, ["rev-parse", "--is-inside-work-tree"]).ok) {
    return row("refuse", "not a git worktree");
  }
  // Empty --show-prefix IFF <path> is its worktree's top level (tap-zp5zj).
  const prefix = git(target, ["rev-parse", "--show-prefix"]);
  if (!prefix.ok) return row("keep", "could not resolve worktree prefix (fail-closed)");
  if (prefix.out !== "") {
    const top = git(target, ["rev-parse", "--show-toplevel"]);
    return row("refuse", `not a worktree top level (enclosing worktree ${top.ok ? top.out : "?"})`);
  }
  // Primary discriminator: in a linked worktree --git-dir lives under the
  // primary's .git/worktrees/<name>, so the two differ; in the primary they
  // resolve to the same directory. Never a path-name comparison.
  const gd = git(target, ["rev-parse", "--absolute-git-dir"]);
  const common = git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!gd.ok || !common.ok) return row("keep", "could not resolve git dirs (fail-closed)");
  if (gd.out === common.out) return row("refuse", "primary checkout");

  const claim = indexClaim(target);
  if (claim === null) return row("keep", "machine index unreadable (fail-closed)");
  if (claim !== "") return row("refuse", claim);

  // Branch deletion has no detached candidate. Decide that before dirty/locked
  // holds, or a dirty detached tree looks like a hold a human could clear into
  // a deletion. Checkout removal keeps the old order: state holds first.
  if (question === "branch") {
    const early = git(target, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!early.ok && early.code !== 1) return row("keep", "could not read HEAD (fail-closed)");
    if (!early.ok) return row("refuse", "detached HEAD; no branch to delete");
    // main, master, and whatever origin/HEAD names are not deletion candidates,
    // even in a linked worktree and even when a PR row would otherwise
    // corroborate them. An absent or unreadable origin/HEAD means the remote
    // default is unknown, so a lane branch keeps. main and master still refuse.
    let protectedBranch = early.out === "main" || early.out === "master";
    if (!protectedBranch) {
      const remoteHead = git(target, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      if (!remoteHead.ok) return row("keep", "could not read the remote default branch (fail-closed)");
      const slash = remoteHead.out.indexOf("/");
      const name = slash === -1 ? remoteHead.out : remoteHead.out.slice(slash + 1);
      protectedBranch = name !== "" && early.out === name;
    }
    if (protectedBranch) return row("refuse", "refusing to license deletion of main, master, or the remote default branch");
    earlyBranch = early.out;
    // gh pr view treats an all-digit operand as a PR number, so a branch
    // named 123 would be corroborated against PR 123.
    if (/^[0-9]+$/.test(earlyBranch)) return row("keep", "numeric branch name is ambiguous with a PR number (fail-closed)");
    const where = checkedOutElsewhere(target, earlyBranch);
    if (where === "unreadable") return row("keep", "could not list worktrees (fail-closed)");
    if (where === "elsewhere") return row("refuse", "branch is checked out in another worktree");
  }

  // R1: the lock probe is its OWN git-dir lookup, and a failed lookup keeps —
  // "lookup failed" is not "no lock" (a single shared lookup would delete this
  // ruled branch and its arm).
  const lockDir = git(target, ["rev-parse", "--absolute-git-dir"]);
  if (!lockDir.ok) return row("keep", "could not resolve git dir for lock probe (fail-closed)");
  if (isRegularFile(`${lockDir.out}/locked`)) return row("hold", "worktree locked");
  const status = git(target, ["status", "--porcelain"]);
  if (!status.ok) return row("keep", "git status failed (fail-closed)");
  if (status.out !== "") return row("hold", "working tree dirty");

  const head = git(target, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok) return row("keep", "could not read HEAD (fail-closed)");
  tip = head.out;
  // rc 1 from --quiet symbolic-ref is the LEGITIMATE detached answer; every
  // other not-ok result — rc > 1 or an unusable child (null status maps to
  // code -1) — must keep, or an unreadable HEAD walks into a reclaim heuristic
  // wearing the detached answer (arms 12/12b).
  const sym = git(target, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!sym.ok && sym.code !== 1) return row("keep", "could not read HEAD (fail-closed)");
  branch = sym.ok ? sym.out : "";
  // A detached checkout can still reclaim via ref containment. That license is
  // checkout removal only: the containing ref is not a branch this question may delete.
  if (question === "branch" && branch === "") {
    return row("refuse", "detached HEAD; no branch to delete");
  }
  // The deletion target is the name protected above. A switch between the two
  // reads must not license the new name.
  if (question === "branch" && branch !== earlyBranch) {
    return row("keep", "branch changed during the check (fail-closed)");
  }

  let evidence = "";
  let prHead = "";
  let prCommits: string[] = [];
  if (branch !== "") {
    // R1: every query on the way to completion evidence fails closed, and a
    // failed gh call DISCARDS its partial stdout — a MERGED line followed by a
    // non-zero exit is not evidence.
    const url = git(target, ["remote", "get-url", "origin"]);
    if (!url.ok) return row("keep", "origin remote unresolvable (fail-closed)");
    const facts = prFacts(url.out, branch);
    if (facts.kind === "unusable") return row("keep", `gh unavailable (fail-closed; branch ${branch})`);
    if (facts.kind === "failed") return row("keep", `no usable PR answer for branch ${branch} (gh exit ${facts.code}; fail-closed)`);
    if (facts.kind === "answer" && (facts.state === "MERGED" || facts.state === "CLOSED")) {
      prHead = facts.head;
      prCommits = facts.commits;
      // R3 (tap-dg8g): a branch name is a locator, not an identification — the
      // name is reusable and the tree may hold NEW work the merged row knows
      // nothing about. Corroborate HEAD against the PR's own oids before the
      // row counts as completion. M (the squash commit) is EQUALITY only: it
      // never contains the branch tip. Missing headRefOid, rc 1 (tip ahead of
      // or diverged from the PR head), and any other/unusable ancestry result
      // keep — the checker never removes on an uncorroborated row. Branch
      // deletion is the exception when ancestry cannot run because the head
      // object is absent and the already-read commit list contains the tip.
      if (facts.head === tip || (facts.merge !== "" && facts.merge === tip)) {
        evidence = facts.state === "MERGED" ? `PR MERGED (branch ${branch}), HEAD corroborated` : `PR CLOSED — abandoned (branch ${branch}), HEAD corroborated`;
      } else if (facts.head === "") {
        return row("keep", `PR ${facts.state} (branch ${branch}) lacks head corroboration (fail-closed)`);
      } else {
        const mb = git(target, ["merge-base", "--is-ancestor", tip, facts.head]);
        if (mb.ok) evidence = `PR ${facts.state} (branch ${branch}), branch tip contained by PR head`;
        else if (mb.code === 1) {
          // Branch deletion names the commits the PR does not have. Checkout
          // removal keeps the older ahead-or-diverged wording.
          const ahead = question === "branch"
            ? `PR ${facts.state} (branch ${branch}), but branch tip ${tip.slice(0, 7)} has unpublished commits beyond PR head ${facts.head.slice(0, 7)}`
            : `PR ${facts.state} (branch ${branch}), but branch tip ${tip.slice(0, 7)} is ahead of or diverged from PR head ${facts.head.slice(0, 7)} (fail-closed)`;
          return row("keep", ahead);
        } else if (question === "branch" && facts.commits.includes(tip)) {
          // The head object is absent locally, so ancestry cannot run. The PR
          // row already lists this tip; that is the corroboration branch
          // deletion is allowed to use, with no further network query.
          // Checkout removal stays on the ancestry result below.
          evidence = facts.state === "MERGED" ? `PR MERGED (branch ${branch}), HEAD corroborated` : `PR CLOSED — abandoned (branch ${branch}), HEAD corroborated`;
        } else {
          return row("keep", `PR head ${facts.head.slice(0, 7)} object unavailable locally (fail-closed); fetch and re-check`);
        }
      }
    }
  } else {
    // Detached: ref containment first (tap-6a4ao) — local, deterministic, and
    // it must make NO gh lookup, so the stub-counting arm can prove the order.
    const reach = git(target, ["for-each-ref", "--format=%(refname)", "--contains", "HEAD", "refs/heads/", "refs/remotes/"]);
    if (!reach.ok) return row("keep", "ref-containment query failed (fail-closed)");
    if (reach.out !== "") {
      const refs = reach.out.split("\n");
      return row("reclaim", `detached HEAD contained by ${refs[0]} (${refs.length} ref(s)); the tree holds nothing a ref does not`);
    }
    // Name recovery: the tree name gives a CANDIDATE PR; only the oids make it
    // an identification (arm 10).
    const base = target.replace(/\/+$/, "").split("/").pop() ?? "";
    const num = /^[A-Za-z]+([0-9]+)[A-Za-z]*$/.exec(base)?.[1];
    if (num !== undefined) {
      // R1: the ordinal route's gh queries keep the same fail-closed rows.
      const url = git(target, ["remote", "get-url", "origin"]);
      if (!url.ok) return row("keep", "origin remote unresolvable (fail-closed)");
      const facts = prFacts(url.out, num);
      if (facts.kind === "unusable") return row("keep", `gh unavailable (fail-closed; branch ${num})`);
      if (facts.kind === "failed") return row("keep", `no usable PR answer for branch ${num} (gh exit ${facts.code}; fail-closed)`);
      if (facts.kind === "answer" && (facts.state === "MERGED" || facts.state === "CLOSED")) {
        // Detached name-recovery keeps the EXACT-equality identification: the
        // name gave a candidate, and only the tree's HEAD being one of that
        // PR's own commits makes it an identification (arm 10).
        const corroborated = (facts.merge !== "" && facts.merge === tip) || (facts.head !== "" && facts.head === tip) || facts.commits.includes(tip);
        if (corroborated) {
          evidence = facts.state === "MERGED" ? `PR #${num} MERGED, HEAD corroborated` : `PR #${num} CLOSED — abandoned, HEAD corroborated`;
        }
      }
    }
  }
  if (evidence === "") {
    return row("keep", branch !== ""
      ? `no completion evidence (branch ${branch}: no merged or closed PR)`
      : "no completion evidence (detached: HEAD contained by no branch or remote-tracking ref, and no PR recovered from the tree name or its commits do not match this HEAD)");
  }
  // Preservation is the LAST conjunct and never the evidence (tap-t7rk).
  // Branch deletion does not treat a local remote-tracking ref as publication.
  // The PR row already read supplies headRefOid and the commit list; a missing
  // head fails closed. Content already on origin/main remains the squash catch.
  if (question === "branch") {
    if (prHead === "") return row("keep", `${evidence}, but the PR lacks headRefOid (fail-closed)`);
    if (prHead === tip || prCommits.includes(tip)) {
      return reclaimBranch(`${evidence}; the PR's head commit contains the branch tip`);
    }
    const landedBranch = git(target, ["diff", "--quiet", "origin/main", "HEAD"]);
    if (landedBranch.ok && landedBranch.code === 0) return reclaimBranch(`${evidence}; content already on origin/main (squash catch)`);
    if (!landedBranch.ok && landedBranch.code === 1) return row("keep", `${evidence}, but the tree holds unpublished content differing from origin/main`);
    return row("keep", `${evidence}, but the origin/main comparison failed (fail-closed)`);
  }
  const published = git(target, ["branch", "-r", "--contains", "HEAD"]);
  if (!published.ok) return row("keep", "remote-containment query failed (fail-closed)");
  if (published.out !== "") return reclaimBranch(`${evidence}; commits published on a remote`);
  const landed = git(target, ["diff", "--quiet", "origin/main", "HEAD"]);
  if (landed.ok && landed.code === 0) return reclaimBranch(`${evidence}; content already on origin/main (squash catch)`);
  // rc 1 is the healthy "content differs" answer; rc >= 2 or an unusable child
  // (code -1) is a BROKEN comparison and keeps with its own evidence (25b).
  if (!landed.ok && landed.code === 1) return row("keep", `${evidence}, but the tree holds unpublished content differing from origin/main`);
  return row("keep", `${evidence}, but the origin/main comparison failed (fail-closed)`);
}

type PrAnswer =
  | { kind: "answer"; state: string; merge: string; head: string; commits: string[] }
  | { kind: "unusable" }
  | { kind: "failed"; code: number };

// gh pr view <ref>: state, merge oid, head oid, comma-joined listed commit oids.
// UNUSABLE (absent, killed, ENOBUFS) learned nothing; FAILED (exit n) had its
// partial stdout discarded (R1); neither is "no PR" — the caller keeps on all.
function prFacts(remote: string, ref: string): PrAnswer {
  const r = spawnSync("gh",
    ["-R", remote, "pr", "view", ref, "--json", "state,mergeCommit,headRefOid,commits",
      "-q", '[.state, (.mergeCommit.oid // ""), (.headRefOid // ""), ([.commits[].oid] | join(","))] | @tsv'],
    { encoding: "utf8", maxBuffer: REGISTRY_MAX_BUFFER });
  const outcome = spawnOutcome(r);
  if (outcome === "unusable") return { kind: "unusable" };
  if (r.status !== 0) return { kind: "failed", code: r.status ?? -1 };
  const [state = "", merge = "", head = "", commits = ""] = (r.stdout ?? "").trim().split("\t");
  return { kind: "answer", state, merge, head, commits: commits.split(",") };
}

// The machine index's claims on <target>: "" unclaimed, a reason when claimed,
// null when the index exists but cannot be read (caller keeps, never "unclaimed").
// Historical teams contribute nothing (tap-zp5zj); roots compare by EQUALITY,
// never containment; seat occupancy is the current `seats` map, and an
// old-format acting registry claims the tree outright (old_store).
function indexClaim(target: string): string | null {
  const index = globalRegistryPath();
  if (!isRegularFile(index)) return "";
  let doc: Record<string, unknown>;
  try {
    doc = readIndexJson(index);
  } catch {
    return null;
  }
  if (!isObj(doc) || !isObj(doc.teams)) return null;
  const targetPhys = physicalPath(target);
  for (const [name, team] of Object.entries(doc.teams)) {
    if (!isObj(team)) continue;
    // Only the literal string "historical" skips the team (arm 16). A wrong
    // JSON type must never suppress claims: python str() renders a malformed
    // singleton array "['historical']" — not historical — and a JS String()
    // would read it AS historical, failing open toward reclaim (arm 16b).
    if (team.state === "historical") continue;
    const root = team.root;
    if (typeof root === "string" && root !== "" && physicalPath(root) === targetPhys) {
      return `enrolled team root (${name}); stop its seats and de-enroll first: tap team shutdown ${name}`;
    }
    const reg = team.registry_location;
    if (typeof reg !== "string" || reg === "") continue;
    let acting: Record<string, unknown>;
    try {
      acting = readIndexJson(reg);
    } catch (error) {
      // A missing acting registry is "no bound tree here", not a read failure.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    if (!isObj(acting)) return null;
    // An old-format registry cannot say which seats occupy the tree: claimed, never reclaimable.
    if (teamRegistryRefusal(reg, acting)) return `old_store acting registry (${name})`;
    const bound = isObj(acting.team) ? acting.team.worktree_root : undefined;
    if (typeof bound === "string" && bound !== "" && physicalPath(bound) === targetPhys) {
      return `enrolled team root (${name} via acting registry); stop its seats and de-enroll first: tap team shutdown ${name}`;
    }
    const occ = acting.seats;
    if (!isObj(occ)) continue;
    for (const [handle, seat] of Object.entries(occ)) {
      if (!isObj(seat)) continue;
      const wt = seat.registered_from_worktree;
      if (typeof wt !== "string" || wt === "") continue;
      const phys = physicalPath(wt);
      if (phys === targetPhys || phys.startsWith(`${targetPhys.replace(/\/+$/, "")}/`)) {
        return `registered seat cwd (${name}/${handle})`;
      }
    }
  }
  return "";
}
