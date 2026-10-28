# Issue tracker: GitHub

Issues and specs live in this repository's GitHub Issues. Use `gh`; infer the repository from the checkout's remote.

## Operations

- Read an issue and comments: `gh issue view <number> --comments`.
- List relevant issues: `gh issue list --state open --json number,title,body,labels,assignees`, with appropriate filters.
- Create an issue: `gh issue create --title "..." --body-file <file>`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Change labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close resolved work: `gh issue close <number> --comment "..."`.
- Publishing a spec or tickets means creating GitHub issues; fetching a ticket means reading its full body and relevant comments.
- GitHub shares issue and pull-request numbers. Resolve the object type before operating on it.

This repository is public. Publish only sanitized summaries and source links; keep credentials, private transcripts and raw sensitive evidence local.

## Pull requests as a triage surface

**PRs as a request surface: no.** Existing PRs can still be investigated or reviewed when requested.

## Wayfinding operations

- Map: an issue labelled `wayfinder:map`, containing Destination, Notes, Decisions so far, Not yet specified and Out of scope.
- Decision ticket: a child issue of that map, labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or `wayfinder:task`.
- Link children through GitHub's native sub-issue endpoint. If unavailable, use a task list in the map and `Part of #<map>` in each child.
- Add native blocking edges with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`. Obtain the database id from the issue REST response, not its number or node id.
- If native dependencies are unavailable, use `Blocked by: #<number>` references instead. A dependency is satisfied only when its blocker is closed.
- Frontier: the map's open, unassigned children with no open blockers; retain the map's ordering.
- Claim before execution: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the decision and evidence, close the decision ticket, then add a gist and link to the map's Decisions so far. Preserve unrelated issue content.

## Implementation tickets

Publish approved vertical slices in dependency order, labelled `ready-for-agent`. Use native blocking and sub-issue links where available. Keep acceptance criteria observable through the agreed interfaces. A tracker write is not evidence that the behavior is implemented or verified.
