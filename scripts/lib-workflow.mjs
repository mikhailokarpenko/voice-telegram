// Minimal, dependency-free reader for the subset of GitHub Actions YAML that the
// auth guard workflows use.
//
// Why not a YAML library: pont-web ships no YAML dependency, and the only
// consumer is a CI guard that must run as an early step with nothing installed
// beyond node. The subset below (jobs -> steps -> scalar keys plus `run: |`
// block scalars) is all these workflows contain, and anything outside it is
// reported rather than silently ignored, so the guard cannot go vacuous by
// failing to understand the file it is pinning.

import { readFileSync } from "node:fs";

const indentOf = (line) => line.length - line.replace(/^ +/, "").length;

// Strips one level of YAML quoting from a scalar.
function scalar(raw) {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

// Returns { name, triggers: {push: {branches: [...]}|true, pull_request: ...},
//           jobs: { id: { steps: [ {name, if, uses, run, "working-directory"} ] } } }
export function parseWorkflow(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const wf = { path, name: null, on: {}, jobs: {} };

  let i = 0;
  const atTop = (l) => l.length > 0 && indentOf(l) === 0 && !/^\s*#/.test(l);

  // --- top-level keys -------------------------------------------------------
  const topBlocks = new Map();
  let current = null;
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") { if (current) topBlocks.get(current).push(line); continue; }
    if (atTop(line)) {
      const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
      if (!m) { current = null; continue; }
      current = m[1];
      topBlocks.set(current, []);
      if (m[2].trim()) topBlocks.get(current).push("  " + m[2].trim());
    } else if (current) {
      topBlocks.get(current).push(line);
    }
  }

  if (topBlocks.has("name")) {
    const first = topBlocks.get("name").find((l) => l.trim() && !/^\s*#/.test(l));
    wf.name = first ? scalar(first) : null;
  }

  // --- on: ------------------------------------------------------------------
  // `on` is read by YAML 1.1 as the boolean true; GitHub still keys it "on".
  const onBlock = topBlocks.get("on") || topBlocks.get("true") || [];
  {
    let key = null;
    for (const line of onBlock) {
      if (line.trim() === "" || /^\s*#/.test(line)) continue;
      const ind = indentOf(line);
      const m = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
      if (m && ind === 2) {
        key = m[1];
        wf.on[key] = m[2].trim() ? scalar(m[2]) : {};
        continue;
      }
      const sub = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
      if (sub && key && ind > 2) {
        const val = sub[2].trim();
        const list = /^\[(.*)\]$/.exec(val);
        wf.on[key][sub[1]] = list
          ? list[1].split(",").map((s) => scalar(s)).filter(Boolean)
          : scalar(val);
      }
    }
  }

  // --- jobs: ----------------------------------------------------------------
  const jobBlock = topBlocks.get("jobs") || [];
  let jobId = null;
  let inSteps = false;
  let step = null;
  let runLines = null;
  let runIndent = 0;

  const flushStep = () => {
    if (step) {
      if (runLines) {
        const base = Math.min(...runLines.filter((l) => l.trim()).map(indentOf));
        step.run = runLines.map((l) => l.slice(base)).join("\n").replace(/\s+$/, "");
      }
      wf.jobs[jobId].steps.push(step);
    }
    step = null;
    runLines = null;
  };

  for (const line of jobBlock) {
    const trimmed = line.trim();

    if (runLines !== null) {
      if (trimmed === "" || indentOf(line) >= runIndent) { runLines.push(line); continue; }
      const pending = runLines; runLines = null;
      const base = Math.min(...pending.filter((l) => l.trim()).map(indentOf));
      step.run = pending.map((l) => l.slice(base)).join("\n").replace(/\s+$/, "");
    }

    if (trimmed === "" || /^\s*#/.test(line)) continue;
    const ind = indentOf(line);

    if (ind === 2) {
      flushStep();
      inSteps = false;
      const m = /^\s*([A-Za-z_][\w-]*)\s*:/.exec(line);
      jobId = m ? m[1] : null;
      if (jobId) wf.jobs[jobId] = { id: jobId, steps: [], raw: [] };
      continue;
    }
    if (!jobId) continue;
    wf.jobs[jobId].raw.push(line);

    if (ind === 4) {
      flushStep();
      const m = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
      if (m) {
        inSteps = m[1] === "steps";
        if (!inSteps) wf.jobs[jobId][m[1]] = scalar(m[2]);
      }
      continue;
    }
    if (!inSteps) continue;

    if (/^\s*-\s/.test(line)) {
      flushStep();
      step = {};
      const rest = line.replace(/^\s*-\s/, "");
      const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(rest);
      if (m) applyKey(m[1], m[2], ind + 2);
      continue;
    }
    if (step) {
      const m = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
      if (m) applyKey(m[1], m[2], ind);
    }

    function applyKey(key, rawValue, keyIndent) {
      const value = rawValue.trim();
      if (key === "run" && (value === "|" || value === ">" || value === "|-")) {
        runLines = [];
        runIndent = keyIndent + 2;
        return;
      }
      step[key] = scalar(value);
    }
  }
  flushStep();

  return wf;
}

// All shell that a job actually executes, in order.
export function jobCommands(job) {
  return job.steps.filter((s) => typeof s.run === "string").map((s) => s.run);
}
