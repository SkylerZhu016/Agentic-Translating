Quality evaluation entry point

Public scripts contain no personal filesystem path, credential or dataset. Supply
--campaign-dir, --credential-file and --plan, or select a private --settings file.
Private settings fields: repoRoot, campaignDir, credentialFile, plan, budgetRmb,
maxTokens. Keep settings and source-only manifests outside version control.

Examples (all paths are user-supplied):
  node scripts/quality-eval/runner.mjs status --settings <settings.json>
  node scripts/quality-eval/runner.mjs estimate --settings <settings.json> --condition S0 --split dev
  node scripts/quality-eval/runner.mjs run --settings <settings.json> --condition D --split dev --sample <id> --budget-rmb 10
  node scripts/quality-eval/runner.mjs resume --settings <settings.json> --condition S0 --split dev --sample <id> --budget-rmb 10

Tomorrow's full run:
  node scripts/quality-eval/runner.mjs continue --settings <full100-settings.json> --allow-full100 --authorize-full --budget-rmb 10

The private campaign folder can contain a tomorrow-continue.cmd launcher. Double-
clicking it tomorrow is equivalent to the command above. Creating the launcher
does not authorize or execute anything. Only the user's manual --authorize-full
launch writes a full-run gate bound to the source-only plan and frozen S1 hashes.
It displays the cap, usage-based estimated cost, uncertain reserve, balance,
available observed sample-cost range and per-attempt conservative reservation, then resumes
D and the final S1 only. Completed records are reused. S0 is excluded from full100.
No schedule is created and a new date never resets the existing ledger. The plan,
phase authorization and optional notBefore time must all allow the requested run.
An existing final S1 snapshot is required. A failed output is recorded and the
next sample continues, while budget, authentication, HTTP 402 and runtime errors
stop the run. Resume skips completed and terminal failed samples. Add
--retry-failed to permit one additional sample retry, still subject to all budget
and physical-attempt limits. Monitor timeouts retain the checkpoint for recovery.
The launcher reuses this campaign's original ledger. Changing the date or plan
never grants another RMB 10. Run manually tomorrow, never schedule it tonight.

Pilot input:
  {planId,scope:"pilot",approved,samples:[
    {sampleId,split:"dev"|"holdout",sourceText,taskBrief,constraints}
  ]}
Full input has scope:"full100", exactly 100 samples and split:"full".
taskBrief contains the common context, audience, purpose, priorities, style and
all hard requirements. Dataset constraints arrays stay in taskBrief. Only
poetryMode is mapped into the product constraints object. Line count is never
silently treated as stanza count. Optional agent IDs select two or three distinct
candidates. Reference translations, Astra text and grades belong in separate
review files, never in the source-only plan. The runner projects a field allowlist
and never reads reference/review directories.

All conditions share <campaignDir>/global-budget/budget-ledger.json. The explicit
cap is immutable on resume and at most RMB 10. Each physical request durably
reserves 1,048,576 possible input tokens at peak miss price, plus the output cap,
before network dispatch. Current default max_tokens is 32768, chosen after
observed 8192-token truncations under high reasoning. A 32768 request reserves
RMB 2.359296. This ceiling is not a predicted charge. The gateway serializes
physical requests, so queued requests wait for prior usage settlement.

Output status and billing certainty are independent. A failed/truncated output
with trustworthy prompt cache hit/miss and completion usage is settled at its
measured usage while retaining failure status. Budget occupancy uses offpeak
rates only when the entire recorded UTC+8 interval plus a five-minute buffer on
both sides avoids all Monday-Friday peaks (09:00-12:00 and 14:00-18:00). Invalid,
ambiguous or very long timestamps use peak rates. A separate peakKnownUsageRmb
indicator is always retained. These are official-usage/price estimates, not
observed account debits. Unknown usage retains the full
reserve. Reasoning is included in completion_tokens and is never counted twice.
HTTP 401/402/403 and success responses with invalid/missing usage stop new dispatch.

  node scripts/quality-eval/runner.mjs reconcile --settings <settings.json>
This uses the same exclusive lock to settle trustworthy usage already persisted
by an earlier process. It makes no network request and preserves original output.

Finished tasks are skipped only through product/file checkpoints. The gateway
never replays an HTTP result, so malformed JSON can receive a fresh native retry.
A request hash includes sample/condition and allows at most four physical calls,
matching the product initial attempt plus its three retry delays. Every attempt,
including a proxy fallback, gets its own durable reservation and usage settlement. A reviewed cap increase
uses resume --max-tokens 32768 --retry-reason "observed truncation" and is recorded
in generation history. Existing successful product checkpoints are retained.
A resumed frozen session may retain its former local cap in its product snapshot;
the adapter's actual enforced cap is recorded separately and overrides it.

S0/S1 run the real product HTTP interfaces in separate frozen app/src/config
snapshots and separate databases. This is the supported optional fixed-team
configuration: two context-analysis lenses, three candidate translators and four
editorial stages. Frozen S0 uses three physical review lenses (11 base calls).
The integrated-v1 S1 review uses one combined physical review (9 base calls).
The report records the actual frozen strategy. It is not a handwritten pipeline imitation or the default
dynamic tool-selection mode. Poetry planning and repair can add product calls.

  node scripts/quality-eval/runner.mjs freeze --campaign-dir <campaign> --condition S0
Freeze S0 before prompt edits; freeze S1 only after final tuning. Per-file hashes
are saved. Dependencies are shared using a node_modules junction. No .env, real
database, reference translation or credential file is copied into the snapshot.

The gateway enforces deepseek-flash, thinking enabled, reasoning_effort high and
the configured output cap. Tools and temperature are excluded. Upstream SSE is
read privately. Reasoning text is counted and discarded; only visible content,
usage, reasoning length and timing are persisted. The adapter buffers visible
content and serializes calls. Measured durations include its queueing/buffering
and cannot be presented as native product performance. Keepalives preserve idle
activity, while the product's original 15-minute absolute timeout still applies.

One proxy fallback is permitted only after direct HTTP 502 or a connection
failure, using the explicitly authorized localhost proxy. It gets a separate
reservation. Timeouts do not auto-retry. System proxy settings are unchanged.
Only the selected credentialFile is read for paid execution. Its value never
appears in logs, artifacts or command arguments. The product gets a fake key.
Requested model and provider-returned model/id are separate evidence fields.
Historical calls that did not retain provider model/id remain marked unavailable.
An official alias mapping is documentation background, not response verification.

To refresh cost-report.json from the private ledger and isolated product call
records, use cost-report.mjs --campaign-dir <campaign> --output <campaign>/cost-report.json.
Optional --attribution-file <file> preserves verified attribution of early
canary calls made before request-context tagging was available. The report shows
per-condition, per-sample and per-stage usage including failed/recovery costs.
Estimate reads this report and scales only its observed completed-sample range.
It explicitly labels S0 as a provisional reference until final S1 is measured.

Validation:
  node --test test/experiments/quality-eval-budget.test.mjs
  node scripts/quality-eval/mock-product-smoke.mjs --campaign-dir <campaign>
The smoke uses a fake provider and reads no credentials. It is compatibility
evidence, not translation-quality evidence.

After a crash, inspect gateway.lock and verify its owned PID is gone before
removing that one lock. Preserve the ledger and all unknown reservations.
