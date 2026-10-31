# Preview Re-check Guide

[简体中文](preview-retest.zh-CN.md)

## What this page does

Each preview belongs to a specific task version. When a new preview opens, the system tries to compare it with the previous version. It lists file changes explicitly linked to acceptance criteria, explains why those criteria may need another check, and suggests steps. This helps you plan a re-check; it does not change a human acceptance decision.

This is part of the controlled-preview candidate. See the [controlled preview build guide](controlled-preview-build.zh-CN.md) and [machine-readable validation record](controlled-preview-build-test-results.json). A local user with management access can add file mappings and check steps for the current preview. A limited browser check passed comparison of two versions, saving and reading back a mapping, and restoring **Impact uncertain** after the mapping was removed. A mobile-sized web page also read the same comparison. A separate isolated Mac QA app passed a bounded flow covering two builds, mapping save/read-back, quit/reopen, and preservation of the original task data. It is a temporary QA package, not a formally signed release or complete acceptance. An ordinary Android app passed a limited emulator flow for login, reading the guide, opening the matching preview, and responding to a button tap; physical-phone and complete app flows remain pending. Comparison is limited to source-file mappings supported by this preview; it does not analyze the meaning of arbitrary project configuration or dependencies.

**Verified Android scope:** After reopening the ordinary v13 app in an emulator, login, the saved record, and the single feedback task remained. The new preview showed one criterion requiring re-check and two with uncertain impact, with a changed-file reason and two concrete steps for the affected criterion. Human acceptance stayed unchanged. The APK was not rebuilt; network faults, revocation, and physical-device checks remain separate. The test helper’s close-audit error and the later read-only verification are preserved in the [full test record](android-preview-resume-test-results.json).

## Reading the re-check list

- **Re-check required**: Both source versions were fully checked, and files linked to the selected criterion have changed. Follow the steps on the current preview and record the result.
- **Impact uncertain**: The source or file scope could not be fully verified, the task version changed, the list is limited, or the criterion has no explicit file mapping. Check against the original acceptance criterion. “Unknown” does not mean “unaffected” and does not waive a check.
- The page shows what changed, why to check, and how to check. You can expand the linked files; this comparison guide does not display their contents.

If the source is offline, there is no comparable previous version, source evidence is incomplete, or the task and preview do not match, the system will say that a reliable comparison is unavailable. Do not treat “no change found” as a pass or overwrite the existing human acceptance status.

After network or computer connectivity returns, select **“重新读取重验说明” (Refresh re-check guide)** to reload the comparison list. This only reloads the guide; it does not reopen the trial preview. You can open the preview separately.

If reading the source does not respond for a long time, the page will say **Temporarily unable to verify**. You can read again after the connection recovers. Do not use this message as a reason to skip the check. APP979 adds a readback and new-version guide observation for an existing project; the complete phone flow still awaits end-to-end integration.

## On the Mac management view: map files and check steps

1. A local user with management access opens the current version in the task’s preview area and confirms that it is tied to the task and version they intend to check.
2. Expand **Map files and check steps for this version**, then choose an acceptance criterion.
3. Search for and select files directly relevant to that criterion. The list comes from the verified source inventory for this version. You can select up to 20 files per criterion. Deleted files may also appear.
4. Enter one practical check step per row, with an action and an observable result. For example: “Open Settings, change an option, refresh, and confirm the selection remains.” Avoid vague steps such as “check that it works.” Each criterion allows up to five steps.
5. Select **Save check guide for this version**. Saving records the check method for this preview version. It does not pass acceptance or reopen the preview.

Map only files that can explain an impact. If you cannot confirm a mapping, leave it empty; the system will continue to show the impact as uncertain and require a manual check.

## If the save result is unclear

If saving times out, the connection drops, or the page says the result is unconfirmed, do not submit again or assume it was saved. Select **Read current settings again** and check what the page returns:

- If the content matches what you entered, the page confirms that the **current settings match your entry**. This is not an independent receipt for the original request.
- If the returned content differs, the page shows the current settings so you can continue reviewing them. This does not establish whether the original request succeeded. Check the current task, preview, and returned content first; then a user with management access can explicitly decide whether to save again.
- If reading fails, the save result remains unconfirmed. Continue checking the returned settings; do not submit the save again.

Do not rely on this mapping to waive a check until you have read it back and reviewed it. Existing human acceptance records remain unchanged.

## Phone view and current validation boundary

The phone view is for reading the re-check guide and does not allow editing file mappings. The isolated Mac QA app passed its bounded flow; active AI, a busy terminal, and a formal release package remain untested. A limited ordinary-app emulator flow passed, but the APK was not rebuilt from this source revision; this is not physical-phone or complete task-flow acceptance. The Mac local flow, mobile-sized web page, and phone app are separate acceptance items. On the phone, continue checking against the task’s original acceptance criteria until app integration has a clear result.

Neither **Re-check required** nor **Impact uncertain** is an acceptance decision. After performing the check, record the result through the existing human acceptance flow. The re-check guide does not automatically pass, revoke, or rewrite an existing acceptance.
