# FAJ Work integration

The existing guest table URLs, slugs, public origin and table tent designs remain unchanged.

`GET/POST /api/integrations/crm/work` uses the existing server-only `x-qrnastol-staff-secret` and a verified `x-faj-work-max-user` supplied by CRM after authenticating the employee. Browser-supplied employee IDs are never used. Qr checks active staff, role, shift, zone and the accepted call owner before mutations. The endpoint exposes only the current employee's operational view, not the admin snapshot or other messenger IDs.

FAJ Work displays shifts, current calls, checklist completion, personal shift tasks and rollover reasons. Qr remains their source of truth. CRM guest-card access uses its existing `loyalty_orders` role permission independently of Qr roles.

For staff linked to the FAJ Work MAX bot, ordinary accepted table-call cards disappear from MAX and completion moves to FAJ Work. Persisted `workManaged` and message `deletePending` fields survive a restart. Failed deletions retain references and retry; history and escalation timers remain intact. Existing unlinked staff keep the old bot completion flow. Accepted overdue escalation cards continue to reach administrators/owners.

Personal shift tasks, rollover notices and checklist/shift-end reminders for connected staff are sent through the CRM FAJ Work outbox. `/var/lib/qrnastol/faj-work-outbox.json` retains events while CRM is unavailable; CRM deduplicates each employee/event key. It contains notification text and IDs, never bot tokens. Do not delete it during release or rollback.

Deployment: first activate the matching CRM change using its protected publisher; then run `deploy/release-work.sh <commit> <git-archive-path> <previous-commit>` on the verified host. The script checks a clean production source, the release lock, commit ancestry, current markers, tests/build in staging, a data/source recovery point, readiness and the unchanged table identity fingerprint. Rollback restores code/build only, preserving live calls and the durable notification queue. No database migration is required.

Scope: shift-control admin notices and direct responses to legacy bot commands remain available there. Automatic staff meal pricing and iiko staff-discount rules are not altered by this change.
