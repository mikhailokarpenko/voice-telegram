// Indentation-aware extraction of Python def/class bodies.
//
// Why not a regex over the whole file: every guard hole audited in this repo so
// far had the same shape -- the guard grepped for a token that survived the
// mutation, or sliced the file with indexOf() on a name the mutant renamed, so
// the slice was empty and every `!/bad/.test(slice)` assertion passed
// vacuously. Callers here get an explicit `null` for "not found" and a body
// they can length-assert, so a missing block is a FAILURE, never a pass.

/** Return the source of `def name(` / `class name` including its indented body, or null. */
export function pyBlock(src, kind, name) {
  const lines = src.split("\n");
  const head = new RegExp(`^(\\s*)(?:async\\s+)?${kind}\\s+${name}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const out = [lines[i]];
    // A signature may span lines; while its parens are open, keep consuming
    // regardless of indentation (`) -> Response:` sits at the header indent).
    const depth = (s) => (s.match(/[([{]/g) || []).length - (s.match(/[)\]}]/g) || []).length;
    let open = depth(lines[i]);
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (open > 0) { out.push(l); open += depth(l); continue; }
      if (l.trim() === "") { out.push(l); continue; }
      const li = l.length - l.trimStart().length;
      if (li <= indent) break;
      out.push(l);
    }
    return out.join("\n");
  }
  return null;
}

/** Strip `#` comments (outside strings is good enough for our sources). */
export function stripComments(src) {
  return src.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
}

/** Integer default of a keyword-only-ish parameter in a signature block, or null. */
export function intDefault(block, param) {
  const m = new RegExp(`${param}\\s*:\\s*int\\s*=\\s*(-?[0-9_]+)`).exec(block || "");
  return m ? Number(m[1].replace(/_/g, "")) : null;
}
