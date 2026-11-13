// The agent session a command is running inside, read from the environment the
// harness exports to its tool shells. Children inherit it, so it survives
// agent -> bash -> script chains. Returns "" when no session is detectable.
//
//   TRACKERBOARD_SESSION      explicit override (id or https URL)
//   CLAUDE_CODE_SESSION_ID    Claude Code
//
// A bare id is stored as `<harness>:<id>`. If TRACKERBOARD_SESSION_URL is set
// (a template containing {id}), the id is expanded into that URL instead, which
// is what makes the owner mark on the page a link.
export function detectSession(env = process.env) {
  const explicit = (env.TRACKERBOARD_SESSION || "").trim();
  const harness = explicit ? "" : env.CLAUDE_CODE_SESSION_ID ? "claude" : "";
  const id = explicit || (harness ? env.CLAUDE_CODE_SESSION_ID.trim() : "");
  if (!id) return "";
  if (/^https:\/\//.test(id)) return id;
  const template = (env.TRACKERBOARD_SESSION_URL || "").trim();
  if (/^https:\/\/.*\{id\}/.test(template)) return template.replaceAll("{id}", encodeURIComponent(id));
  return harness ? `${harness}:${id}` : id;
}
