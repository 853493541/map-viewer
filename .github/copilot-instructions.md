# Project rules

## ALWAYS RE-READ BEFORE EDIT

**Every file you edit, you MUST re-read its current contents from disk
immediately before making the edit.** Do not rely on file contents you
read earlier in the conversation — the file may have been changed by
the user, by a previous edit you made, by a build step, or by another
agent. Acting on a stale snapshot causes broken `oldString` matches,
silent overwrites of fresh changes, and "I already fixed that" loops.

This rule applies to:
- `replace_string_in_file` / `multi_replace_string_in_file`
- Any tool that takes an `oldString` argument
- Any decision based on "what's currently in the file"

The only exception: a single batch of edits to **different files** where
each file was just read in the same turn.

## PSS audit truth table

- `materialIndex == null` (i.e. the launcher authored
  `nMaterialIndex = 0xFFFFFFFF`) on a Trail-class / ribbon launcher is
  **expected, not a gap**. Trail launchers get their texture from the
  type-3 ParticleTrack block via the procedural ribbon renderer.
- Mesh-binding audit must classify launchers by class first and pick the
  right success criterion: material-class → `materialIndex` resolves;
  trail-class → track block has a resolvable texture.
