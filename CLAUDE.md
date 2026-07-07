# CLAUDE.md — bn-webapp

## Git rules ⚠️
- **Commit messages: one short sentence.** No body, no bullet lists, no trailer.
- **Do NOT add a `Co-Authored-By` line** (no Claude co-author trailer).
- **Author must be scb-lion only** — never `Tiz20lion`. This repo pins local
  config: `user.name=scb-lion`, `user.email=scb-lion@users.noreply.github.com`.
  Verify a push landed as scb-lion:
  `curl -s https://api.github.com/repos/scb-lion/bn-webapp/commits/main | grep '"login"'`.
