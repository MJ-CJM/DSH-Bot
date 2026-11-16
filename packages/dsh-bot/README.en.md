<p align="center">
  <img src="assets/logo-1024.png" alt="DSH-Bot" width="160" height="160">
</p>

# DSH-Bot

English · [中文](README.md)

**Your personal agent workspace.** Create Bots with their own roles, memory and tools in DeepSeek Harness. Keep working in ongoing conversations, collaborate, and receive results in the original chat.

**Current source: 0.7.0 release candidate, not published (npm package: `dsh-botgroup`).** This page describes the candidate's Bot mode, Supergroup and simpler workflows. For the published **[stable 0.6.7](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.6.7)**, use its own release notes and assets. [Changelog](https://github.com/MJ-CJM/DSH-Bot/blob/main/CHANGELOG.md).

![Personal Bot workspace example](https://raw.githubusercontent.com/MJ-CJM/DSH-Bot/main/packages/dsh-bot/assets/showcase/en-bots.png)

Screenshots show basic workflows from an earlier version in a real, isolated DSH environment, with fictional data and scripted replies. Current candidate entry points are described below. Screenshots do not establish real-model task quality.

## Start with one Bot

Once installed in an environment **with the matching host adapters**, everyday use does not require creating a project or assembling a team first:

1. Choose **Bot mode** from the mode menu at the bottom left, select or create a Bot, and describe your task. For example: “Compare these two proposals. Ask the researcher and reviewer to help if needed.”
2. The Bot can ask teammates, delegate or form a team for the current task, inviting existing experts when needed. You can inspect collaboration, while the initiating Bot delivers the result in the **original conversation**.
3. To add a file, open **Materials and details → Materials** at the top right, choose a text file for this task, and continue the original work. Add requirements or stop through the existing work controls.
4. Open **Work & manage** at the bottom left for the Bot/group directory and tasks needing your attention. You can reach these without switching to Standard mode.

Bot mode enables collaboration within tasks. Switching to Standard mode stops collaboration and keeps records; the mode applies across all windows. File permissions, tool approvals and model configuration remain those of the host. Chat requires an available DSH model, and model services may charge for usage.

## Find everyday features

| What you want to do | Where and what happens |
| --- | --- |
| View tasks and follow-up | Bot or group conversation → Materials and details → Tasks. Explicitly enable follow-up for that Bot/group. |
| Add materials and continue | Materials and details → Materials. Select the exact task and text file; the original question is kept by default, with optional additional requirements. |
| Find pending work | Work & manage → Tasks needing your attention. Return to the original conversation to provide input, verify results or use native questions/approvals. |
| Manage roles and memory | Bot → Materials and details → Details, then full settings or Manage saved memories. |
| Change group preferences and reuse teams | Group → Materials and details → Settings, including Team recipes. |
| Configure optional services | Advanced settings in Work & manage. Continue everyday tasks in the Bot/group conversation. |

### Automatic collaboration, results in the original chat

Supergroup reuses DSH's native subtasks, models, tools and approvals. Existing Bots can form a team for the task and request support from other existing experts during collaboration. You do not need to select every member in advance. Inspect real members, execution, usage and public results in the group, add task input or stop collaboration.

Shared inputs are the current task text, explicitly selected materials and authorized results. Private chats and private memories are not automatically handed to teammates in full. A working directory is not a file sandbox. Actual answers and delegation depend on the model, tools, permissions and task materials.

### Add missing materials or connections, then continue the same work

The Materials page shows the original task and authorized readers, and lets you select bounded text files directly. When a connection blocks a task, open its connection and credential settings from that work. **A ready connection still requires an explicit continuation**; saving configuration does not automatically replay the task.

The work directory collects items needing input or review, unknown outcomes and available native question/approval entry points. Opening or reading an item does not resolve it. Approvals remain in native controls. If execution or delivery is uncertain, verify the existing operation before continuing; it is not automatically rerun.

### Optional, unscheduled follow-up

Use **Materials and details → Tasks → Turn on follow-up** for the current Bot or group. Viewing and refreshing locally makes no model requests and requires no GitHub account or external credentials. Following and executing work are separately authorized.

Supported task cards offer **Follow this task**, prefilling the name, available condition and an editable deadline. Observe completion of a native subtask or the next GitHub CI result from an already configured source, or register an item with a manual completion condition. **Edit or cancel before saving; opening the form creates no watch.** A matching result becomes a review card without automatically starting a model or repeating the task.

Registration through a personal Bot chat uses native tool approval. A group-chat proposal takes effect only after explicit confirmation. Stop an item or pause observation for its Bot/group. This feature **does not provide timed reminders** and needs a running local DSH Host. Ordinary schedules continue to use native DSH facilities.

### Trace and review memory changes

Each Bot has independent memory. Open **Recent memory changes** in its memory page to inspect sources, timestamps and before/after differences. For an eligible historical version, explicitly choose **Restore as new revision**. This cannot revive forgotten, revoked or currently inaccessible content.

With the Bot's memory enabled, use **Memory → Group work this Bot joined** to find work it actually participated in and can still access, and open its source. **Ask in direct chat** in a group member's menu prepares a referenced draft for you to send. Finding group work does not automatically save it as long-term memory, and private memories are not automatically shared.

### Save team preferences and use ordinary groups on demand

**Team recipes** in group settings previews the current team automatically and lets you save it directly. Import and JSON editing are under advanced controls; export remains available in the preview. Preview role mappings and explicitly confirm membership changes before applying. Recipes contain team preferences without chats, memories, credentials or execution authorization. **New members can read that group's shared history.**

New manually created ordinary groups select relevant speakers locally for each question by default; turn this off in settings if preferred. Explicit mentions, replies and rounds take priority. Unmatched questions use the existing route. Selection makes no decider-model call; member answers still use models. Existing groups keep their preferences. Automatic Supergroup teams collaborate around the task without ordinary-group routing configuration.

![Ordinary group collaboration and member execution example](https://raw.githubusercontent.com/MJ-CJM/DSH-Bot/main/packages/dsh-bot/assets/showcase/en-group.png)

Native background tasks, result review, ordinary schedules, Bot messages, and optional document-snapshot analysis and working-method evaluation remain available through task/management entry points. Configure advanced execution and external connections when needed; neither is required to start a Bot conversation.

## Installation and compatibility

| Scope | Current status |
| --- | --- |
| Published stable release | [0.6.7 Release](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.6.7). Do not assume this page's candidate features are included in that package. |
| Current candidate | 0.7.0, not publicly released. Product archive: `dsh-botgroup-0.7.0.tgz`. Use the prepared, verified candidate package with its matching compatibility artifacts. |
| Full Bot mode | Requires command routing, chat-action and blank-session preset adapters. The verified official desktop combination is **macOS arm64 DSH 0.2.2-rc.3 + its independent dsh-bot-web-app adapter + DSH-Bot**. |
| Other hosts | Declared range: `>=0.2.1-rc.2 <0.3.0`; development dependencies are pinned to `0.2.1-rc.2`. This does not establish testing on every version/platform. A stock host missing the required capabilities rejects full Bot mode. |

**Installing the DSH-Bot tgz alone does not supply the host adapters.** Cross-version automatic fallback is not implemented. Check and migrate the compatibility composition when upgrading DSH. Compatibility artifacts target an exact host version; do not reuse the rc.3 composition on another version. Modifying the official application signature is not required.

### Published releases

The public npm package is **[dsh-botgroup](https://www.npmjs.com/package/dsh-botgroup)**. The DSH-Bot product brand, plugin ID and data directory remain DSH-Bot/`dsh-bot`. The stable versioned archive is `dsh-botgroup-0.6.7.tgz`; the fixed download name `dsh-bot.tgz` is an alias for the same package.

Open the relevant [Release](https://github.com/MJ-CJM/DSH-Bot/releases), read its compatibility notes, and download the plugin tgz and checksum file from that same release. On macOS, for example:

```sh
shasum -a 256 -c dsh-bot.tgz.sha256
```

In DSH, use **Plugins → Add plugin → Install third-party plugin**, select the tgz, enable it as instructed, then fully quit and reopen DSH. Source-code archives are not prebuilt plugins. Community markets or `latest` URLs may still point to the stable release; they do not provide an unpublished candidate or prove Bot-mode compatibility.

### Current candidate

Maintainers should prepare, verify and install the candidate into the matching environment using the [candidate delivery notes](https://github.com/MJ-CJM/DSH-Bot/blob/main/docs/releases/v0.7.0.md). A stable download URL does not mean the candidate is live. Verification and deployment of full Bot mode must check the product package, adapter and exact host version together.

To migrate from the old `dsh-bot` package, stop the Host and back up the complete profile and data. Remove the old package through native plugin management, then install `dsh-botgroup`. Before restarting, inspect the profile's `cordis.patch.yml`: if the original `id: dsh-bot` override has `name: dsh-bot`, change only that name to `dsh-botgroup`. Keep its ID, config and dataDir; do not add a name where none exists. Keep only one package dependency/bundle selected, and review old references in custom includes/templates separately. See the [migration notes](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.6.7).

Before upgrading, back up the original profile and complete data and keep the storage location. Do not delete Bots or reset data as an upgrade step. Rolling back migrated data requires the pre-upgrade backup. Upgrading does not automatically authorize external connections, paid execution or sharing.

## Validation and limits

Candidate features have been tested with real Hosts, persistence and browsers, including light Chinese, dark English, narrow layouts, delivery to the original chat and data preservation, using deterministic local model fixtures. Local development packages previously labeled 0.6.6 were the inputs to those historical checks; **they are not validation receipts for this 0.7.0 release package**. See the [candidate delivery notes](https://github.com/MJ-CJM/DSH-Bot/blob/main/docs/releases/v0.7.0.md) for the exact current artifact and checks. Feature workflows and historical evidence are recorded in [simpler workflows](https://github.com/MJ-CJM/DSH-Bot/blob/main/docs/verification/simple-bot-workflow.md), [incremental acceptance](https://github.com/MJ-CJM/DSH-Bot/blob/main/docs/verification/openmaus-improvements.md), and [host composition verification](https://github.com/MJ-CJM/DSH-Bot/blob/main/docs/verification/official-signed-desktop-update.md).

These checks do not establish real paid-model quality, external account authentication, external IM messaging or automatic compatibility with future hosts. Tasks need a running local Host. Cloud hosting, execution after system exit, and system/mobile push are not provided. Uncertain execution outcomes are not automatically replayed.

## Updates and feedback

[Releases](https://github.com/MJ-CJM/DSH-Bot/releases) · [Report an issue](https://github.com/MJ-CJM/DSH-Bot/issues) · [Security feedback](https://github.com/MJ-CJM/DSH-Bot/blob/main/SECURITY.md)

Include DSH/plugin versions, reproduction steps and redacted screenshots or errors. Do not post keys, private conversations or full profiles.

MIT · Copyright © 2026 MJ-CJM. Third-party notices ship with the package.
