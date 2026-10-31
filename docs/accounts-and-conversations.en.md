# Accounts and remote Codex conversations

For first-time setup, follow the [account setup guide](account-setup.en.md), covering existing-space binding, phone login, desktop connections, pairing codes, and troubleshooting.

The Hub is self-hosted. Replace `https://board.example.com` with your own HTTPS address. Codex runs on the project computer; phones and other computers use the Hub to view authorized projects, send natural-language messages, and read visible output. “CLI-like conversation” means asking Codex to work in natural language. It does **not** run operating-system shell commands from the phone.

## Get connected

**New users:** Open the Hub website and choose **Register**. Registration creates a separate, empty space; it does not import someone else's projects. Usernames are 3–40 letters, digits, underscores, periods, or dashes and start with a letter or digit. Passwords are 12–128 characters. Use the same Hub address, username, and password on your computer and phone.

**Existing Hub owners:** Sign in to the **existing space** with its owner access token. Open **Account (账号) → Set up an account for this space (为当前空间设置账号)**, then choose a username and password. This binds the account to the current space and preserves its projects, tasks, and paired devices. Registering first would create a separate empty space. A space can be bound to only one account.

On the project computer, open **Phone connection (手机连接)**, enter the Hub URL, username, and password, select at least one project to sync, and connect. A one-use **project computer** pairing code is also supported. Keep the computer awake, the board service running, and its Hub connection available. Older desktop builds must be upgraded to use conversations. The Hub does not initiate connections to the computer.

On the phone, open the same Hub URL and sign in with the same account. Alternatively, an owner can create a one-use code with a chosen project scope and permission in **Phone connection (手机连接)**; select **Phone pairing code (手机配对码)** on the phone. A viewer can see task progress but cannot read full conversations, send messages, or control tasks. Controller rights apply only to granted projects. Pairing codes expire and can be used once; revoke lost devices under **Paired connections (已配对连接)**.

## Conversations and status

Open **Talk with Codex (与 Codex 对话)**, select a synced project, and enter a title and first message. The project computer creates a task and Codex session in that project's local directory. Select an existing conversation to send another message or pause a running task. Remote actions respect project grants and local task revisions. New conversation messages cannot be sent while the computer is offline. States such as “submitted,” “awaiting approval,” and “unknown” do not mean Codex has finished. If the outcome is unknown, inspect the task and output before sending again.

The page refreshes visible output about every 2 seconds while open; actual updates depend on the computer, network, and model provider. The Hub syncs conversations for at most 5 requested tasks in selected projects, with a size limit per conversation. Visible AI replies and tool output may contain code, file contents, or generated secrets; protect them like project files. Hidden reasoning is not shared. Free text in project summaries and tasks is not automatically screened for secrets.

## Accounts and security

Browser sign-in uses a 7-day `HttpOnly`, `SameSite=Strict` session cookie; HTTPS deployments also set `Secure`. Signing out revokes the current session. Changing the password under **Account** revokes every browser session for that account, so users must sign in again. **Password changes do not revoke already paired computers or phones**; revoke lost devices individually under **Paired connections**. Existing owner access tokens retain their legacy credential rules.

Email recovery and multi-factor authentication are not implemented. Keep your password and any existing owner token safe; there is no documented password-recovery command. Public access requires HTTPS. Transport encryption is not end-to-end encryption: Hub server operators and administrators with database or backup access can read synced tasks and conversation content. See [Security](../SECURITY.md) and [Deployment](deployment.md).

167 unit/integration checks and Chromium/WebKit mobile flows passed. Two real Codex turns edited a disposable file and returned output to the browser; public HTTPS account/isolation flows also passed. Physical-phone and other native-OS acceptance remain pending. See the [validation report](accounts-conversations-validation.md).

New conversations created by the board allow writing in the selected project, with network access and extra temporary-directory writes disabled for that turn. Global model, approval, and sandbox settings are unchanged; existing external sessions retain their permissions. This Codex version does not restrict all file reads: a controller can ask the AI to read other readable files on the computer. Give control only to trusted people and devices. Hub account isolation is not an operating-system read sandbox. Operations requiring additional permission are stopped; the web UI currently has no approval-granting control.
