# FAJ Work integration

The existing guest table URLs, slugs, public origin and table tent designs remain unchanged.

`GET/POST /api/integrations/crm/work` uses the existing server-only `x-qrnastol-staff-secret` and a verified `x-faj-work-max-user` supplied by CRM after authenticating the employee. Browser-supplied employee IDs are never used. Qr checks active staff, role, shift, zone and the accepted call owner before mutations. The endpoint exposes only the current employee's operational view, not the admin snapshot or other messenger IDs.

FAJ Work displays shifts, current calls, checklist completion, personal shift tasks and rollover reasons. Qr remains their source of truth. CRM guest-card access uses its existing `loyalty_orders` role permission independently of Qr roles.

For staff linked to the FAJ Work MAX bot, ordinary accepted table-call cards disappear from MAX and completion moves to FAJ Work. Persisted `workManaged` and message `deletePending` fields survive a restart. Failed deletions retain references and retry; history and escalation timers remain intact. Existing unlinked staff keep the old bot completion flow. Accepted overdue escalation cards continue to reach administrators/owners.

Personal shift tasks, rollover notices and checklist/shift-end reminders for connected staff are sent through the CRM FAJ Work outbox. `/var/lib/qrnastol/faj-work-outbox.json` retains events while CRM is unavailable; CRM deduplicates each employee/event key. It contains notification text and IDs, never bot tokens. Do not delete it during release or rollback.

The optional FAJ Work call-push pilot is disabled by default (`FAJ_WORK_CALL_PUSH_ENABLED=false`). Activate the compatible CRM release first and enable the flag only for an agreed pilot. Qr continues sending existing Telegram/MAX call cards and retaining the existing escalation timers. Push recipients come from the current call routing and active staff/zone access; CRM resolves the confirmed MAX link and rechecks Work access. A provider acknowledgement is not proof that a phone displayed the notification or that a waiter accepted the call.

`/var/lib/qrnastol/faj-work-call-push-outbox.json` retains pending call pushes over a process restart. Before each retry Qr rechecks the call, cycle, routing stage and recipient; accepted, completed, reassigned and stale notices are discarded. CRM deduplicates successful provider submissions and assigns a short push lifetime. Never delete the outbox during release or rollback. Keep the existing waiter bot enabled while testing on actual locked iPhone/Android devices and throughout the pilot.

The Qr request allows the matching CRM release enough time to reach a slow push provider. CRM bounds both the provider wait and the push lifetime by the call's remaining one-minute validity. Deploy the matching CRM release first; the Qr push pilot remains disabled until device testing is complete.

Deployment: first activate the matching CRM change using its protected publisher; then run `deploy/release-work.sh <commit> <git-archive-path> <previous-commit>` on the verified host. The script checks a clean production source, the release lock, commit ancestry, current markers, tests/build in staging, a data/source recovery point, readiness and the unchanged table identity fingerprint. Rollback restores code/build only, preserving live calls and the durable notification queue. No database migration is required.

Scope: shift-control admin notices and direct responses to legacy bot commands remain available there. Automatic staff meal pricing and iiko staff-discount rules are not altered by this change.
