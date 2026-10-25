# Account-switch sync regression

Base: `4c11d3c99f0849cda8e9a7f296272fc7d73d2a22`.
Fixed head: `aa607800d9385046761be15bbe778ef0b9381541`.

The regression uses one running sync controller and the application’s actual auth subscription, with two simulated account snapshots. Account A syncs revision 8, then an edit is pushed at revision 9. While the controller stays alive, account B becomes current. Two cases cover B holding revision 2 and revision 20. The test requires B’s layout and portfolio to survive the first merge.

On the original base, revision 2 was skipped as stale, and A’s layout overwrote B’s copy. At revision 20, B’s layout was applied but A’s retained edit memo made the old local portfolio list overwrite B’s portfolio. Both cases failed before the fix. On the final fixed head, both pass (two tests, 14 assertions).

`account-change-repro.test.ts` is the original regression extracted from commit `9f4b6aa35595d8eb7afec61fd5df4e491c2490bf`, with compatibility accessors for the old and new internal auth-subscription interfaces. It changes no production source or test assertions. [before.txt](before.txt) retains the original main run (two failures); [after.txt](after.txt) is a fresh run on the final fixed head (two passes), using Bun 1.3.11. The final fixture adds `isSignedIn`, which the original main implementation does not read, so the main result remains unchanged. All throwaway checkouts and profiles were removed.

To reproduce in a detached checkout of either commit:

```sh
repo=/path/to/gloomberb
artifact=/path/to/account-change-repro.test.ts
ref=4c11d3c99f0849cda8e9a7f296272fc7d73d2a22
repro="$HOME/.cache/gloom-smoke/account-change-repro-$ref"
git -C "$repo" worktree add --detach "$repro" "$ref"
ln -s "$repo/node_modules" "$repro/node_modules"
cp "$artifact" "$repro/src/sync/account-change-repro.test.ts"
(cd "$repro" && bun test src/sync/account-change-repro.test.ts)
git -C "$repo" worktree remove --force "$repro"
```

Use the fixed head as `ref` for the passing comparison. The committed suite can be run directly at the fixed head with:

```sh
bun test src/sync/controller.test.ts --test-name-pattern 'switching accounts first merges'
bun test src/sync/account-session.test.ts
```

The session tests additionally use the real API request transport with held authentication headers/body and pending sync work. They cover native credentials and browser-managed cookies, failed authentication and recovery, same-account refresh, overlapping sign-ins, and socket metadata. They do not contact live accounts.

## Authentication response retirement

These are follow-up regressions against the earlier sync fix `f0c8bb8fa21ae81eb85622517896abd765d7fa82`, not failures measured on the original main commit. The same eight tests from `src/sync/account-session.test.ts` fail on that earlier fix ([before log](auth-retirement-before.txt)) and pass on final head `aa607800d9385046761be15bbe778ef0b9381541` ([after log](auth-retirement-after.txt)): eight failures before, eight passes and 60 assertions after, using Bun 1.3.11.

Six cases hold successful or failed sign-in, sign-up and sign-out responses while a device session is adopted. The other two preserve sync state through a tolerated native null-session response and prevent a delayed verification response from adopting an old user with a newer session’s token. These tests use simulated accounts and intercepted responses.

## Cached native session restoration

This follow-up compares `eebb0e61a5d427787ba036522bfc8a28483fde38` with final head `aa607800d9385046761be15bbe778ef0b9381541`. A tolerated null-session response restores the same cached account and unchanged native credential while an email sign-in remains pending. That restoration must preserve the account’s merge state and let the pending sign-in complete.

The new regression fails on the preceding fix ([before log](cached-restore-before.txt)) and passes after removing the unnecessary authentication-generation change from cached-user restoration ([after log](cached-restore-after.txt)): one failure before, one pass and eight assertions after, using Bun 1.3.11. This is a follow-up regression on the earlier fix, not a failure measured on original main.


## Native session retry after a failed refresh

This follow-up regression compares `de9343c8442df04b6f7cbafc70415700c74abc6c` with final head `aa607800d9385046761be15bbe778ef0b9381541`. The runtime fix is commit `ce6c18eb05ee15b7026f57f7b2653a3a27549e34`; the final commit changes only onboarding test fixtures.

A sign-in installs account B’s native token but its response body fails. Session validation and the next refresh fail transiently, then a retry returns no user. The retry must validate B’s token through the account profile instead of associating it with cached account A. The regression verifies B’s identity, token, first merge and revision after recovery.

The test from `src/sync/account-session.test.ts` fails on the preceding fix ([before log](native-retry-before.txt)): the account profile is never checked. It passes on the final head ([after log](native-retry-after.txt)): one pass and 10 assertions, using Bun 1.3.11. The before log is retained unchanged; the after log was freshly rerun on the final head. This is a follow-up regression against the earlier fix, not a failure measured on original main.

To repeat the focused passing checks on the final head:

```sh
bun test src/sync/account-session.test.ts --timeout 20000 --test-name-pattern 'a late sign|a tolerated native|a delayed verification'
bun test src/sync/account-session.test.ts --timeout 20000 --test-name-pattern 'restoring the same native credential'
bun test src/sync/account-session.test.ts --timeout 20000 --test-name-pattern 'a failed native session refresh'
```

The refreshed final-head evidence contains 12 passing tests and 92 assertions across the original extracted two-account fixture and these focused authentication checks. Every before log is unchanged. All temporary checkouts and smoke profiles were removed.

[The locked before/after timing check](timing/README.md) passed all sync and preload-codec budgets on both revisions.
