# Seqivo account setup guide

English | [简体中文](account-setup.md)

Applies to the v0.4.x workflow · Documentation updated October 31, 2026

Accounts are only needed for optional Hub access. The desktop app can read local project progress without registration; start with the [English README](../README.en.md).

This guide uses `https://board.example.com` as a placeholder. Replace it with the real HTTPS address supplied by your service administrator. A public IP address with a valid HTTPS certificate also works. The app currently displays Chinese labels; the labels below match its interface.

**Have an existing space and tasks?** Follow section 2 to enter with the original owner token and bind an account to that space. Then sign in on your phone. Computers already paired to the space stay connected.

**First time, with no existing tasks?** Open the real service address, choose **Register (注册)**, enter a username and a password of at least 12 characters, then select **Create account (创建账号)**. This creates a separate empty space. Connect your project computer using section 4, then sign in on your phone using section 3. Username and password rules are in section 2.3.

## 1. Which account or credential do I need?

| Credential | Purpose | Where to use it |
|---|---|---|
| Seqivo username and password | Access your project space | The website or the desktop app's Phone connection page |
| Seqivo owner token | Enter an existing space and set up its first account | Website → Other connection methods → Access token |
| One-time pairing code | Authorize a phone or project computer, with a defined project scope and role | The phone website or desktop pairing form |
| Codex account | Let Codex execute tasks on the project computer | Codex on the computer; Seqivo login does not replace it |
| GitHub account | Read the source repository and collaborate on development | GitHub; a repository invitation does not create a Seqivo account |
| Server root account | Administer the server operating system | Server administration tools; it is not needed to sign in to Seqivo |

Seqivo currently uses **username login**, with no email login, email verification, or password recovery flow. Do not enter an email address as your Seqivo username.

## 2. Set up an account for your existing space

Do this in a **computer browser**. It preserves the space's projects, tasks, and paired devices.

### 2.1 Locate the original owner token

The administrator who deployed the space keeps its original owner token. For a self-hosted deployment, the initial `bootstrap` command prints the token file's location; see the [Hub deployment guide](deployment.md). Use the token saved when the original space was created. Do not create another space just to obtain a token.

The administrator opens that file on their own device and copies its complete single-line contents. Ordinary users can register their own space or receive a scoped pairing code without obtaining an owner token.

The token grants owner access to the space. Do not commit it to GitHub or share it in group chats or with ordinary collaborators. This repository contains no usable owner token.

### 2.2 Enter the original space

1. Open your actual HTTPS service address in a computer browser.
2. Expand **Other connection methods (其他连接方式)**.
3. Select **Access token (访问令牌)**.
4. Paste the original token and select **Enter board (进入看板)**.
5. Confirm that the expected project names and existing tasks appear.

If the original projects are already visible, continue below. If you signed in to another empty space, open **Account (账号)**, sign out, and follow these steps to enter the original space.

### 2.3 Choose your username and password

1. Open **Account (账号)** in the website navigation.
2. Find **Set up an account for this space (为当前空间设置账号)**.
3. Enter your chosen username and new password.
4. Select **Bind current space (绑定当前空间)**.

| Field | Rules |
|---|---|
| Username | 3–40 characters, starting with an English letter or digit; letters, digits, underscores, periods, and hyphens are allowed. For example, `myaccount`, if available. Lowercase is recommended. |
| Password | 12–128 characters. Choose and store it yourself; you do not need to send it to an AI assistant. |

**Success:** the page confirms that the current space is bound and its projects and tasks are preserved. Account settings display **Currently signed in (当前登录)** with your username. Existing tasks remain on the board.

If your username is already shown, use it to sign in on your phone. Each space can be bound to one account; do not repeat setup for a space that already has one.

> Registering creates a new, separate empty space. To retain existing tasks, use **Bind current space**. New users with no existing tasks can register directly.

## 3. Sign in on your phone

You do not need a phone app or the same Wi-Fi network as your computer.

1. Open your service's HTTPS address in the phone browser.
2. Select **Log in (登录)**.
3. Enter the Seqivo username and password you set up above.
4. Select **Enter board (进入看板)**.
5. Choose your project at the top. Open **Task list (任务清单)** for progress, or **Phone connection (手机连接)** for computer status and the latest sync time.

**Success:** the phone shows the same synced project, existing tasks, and current progress.

Future visits can use account login directly. You do not need to retrieve the owner token or generate a pairing code every time. Account login does not return an additional pairing code that must be entered.

## 4. Check a connected computer or connect a new one

### A computer that is already connected

In the desktop app, open **Phone connection (手机连接)**. Confirm **Connected (已连接)**, the correct HTTPS address, and an updating sync time. Binding an account to its existing space preserves this connection.

### A new or unconnected computer

1. Open Seqivo and create or import a local project. Codex execution requires a real project directory on this computer.
2. Open **Phone connection (手机连接)** → **Connect to your service (连接到自己的服务)**.
3. Complete the form:

| Field | Value |
|---|---|
| Server address (服务器地址) | Your actual HTTPS address, replacing `https://board.example.com` |
| Connection method | Account and password (账号密码) |
| Username / Password (用户名 / 密码) | Your Seqivo credentials |
| Projects allowed to sync (允许同步的项目) | Select the local projects your phone should access |

4. Select **Connect mobile access (连接手机端)**.
5. Wait for **Connected (已连接)**, then refresh the phone website and select the project.

The desktop manages local projects; the website shows projects authorized for sync within the account's space. Signing in does not download source files or migrate another computer's directories or Codex sessions.

## 5. Start a conversation from your phone

The project computer must be awake, online, and running Seqivo. Codex must be signed in, and the connection check under **Integrations and plugins (接入与插件)** must succeed. If the computer sleeps or Seqivo exits, the phone may still show previously synced progress, but cannot start new execution.

1. Select the project at the top of the phone website.
2. Open **Conversations (对话)**.
3. Under **Existing conversations (已有对话)**, select **New conversation (新对话)**.
4. Fill in **Conversation title (对话标题)** and **Tell Codex what to do (告诉 Codex 要做什么)**.
5. Select **Create and start (创建并开始)** and wait for the computer's receipt and conversation output.

A simple first request:

```text
Title: Understand the project
Request: Read this project and briefly explain its entry points, main features,
and test commands. Explain first; do not modify files.
```

Once replies appear, send a specific change request in the same conversation. On later visits, select the task under **Existing conversations (已有对话)**, enter **Further requirements (继续说明需求)**, and select **Send message (发送消息)**. During execution, **Pause execution (暂停执行)** requests a pause; wait for its receipt.

**Success:** the corresponding task appears on the computer, and the phone receives replies or tool output for that conversation. Visible output refreshes about every two seconds while the page is open. Submitted, unknown, or awaiting-authorization states do not mean the work has finished.

The page shows Codex sessions managed by Seqivo or bound to its tasks. It does not automatically list every conversation from other desktop chat applications. Bind an existing task to its execution session on the desktop before trying to control it.

## 6. Optional: connect using a pairing code

Generate pairing codes **on the server website while signed in as the space owner**. The desktop's Phone connection page connects the computer; the website page with the same name manages pairing codes and devices.

### Pair a phone

1. Sign in on a computer browser and open **Phone connection (手机连接)**.
2. Find **Generate one-time pairing code (生成一次性配对码)**.
3. Choose **View and operate (查看和操作)**, or **View only (仅查看)** if task progress is sufficient.
4. Select the authorized projects.
5. Keep the default validity of `600` seconds, or choose an appropriate duration.
6. Select **Generate pairing code (生成配对码)** and copy the displayed code.
7. On the phone login page, open **Other connection methods (其他连接方式)** → **Phone pairing code (手机配对码)**, paste the code, and select **Enter board (进入看板)**. If already signed in, sign out under Account first.

A code works once and expires. Generate a new one if it has expired or been used. View-only devices can see task progress but cannot read full conversations or submit execution requests.

### Pair a project computer

On the website, choose the **Project computer (项目电脑)** role and authorize the target computer's projects. On that computer, open **Phone connection (手机连接)** → **One-time pairing code (一次性配对码)**, enter the server address and code, select the matching local projects, and select **Connect mobile access (连接手机端)**. If a project is not yet visible on the website, enter its desktop project ID in the pairing form's project-ID field.

For your own new computer, account login in section 4 is usually easier.

## 7. Troubleshooting

| Problem | What to check |
|---|---|
| Registration succeeded, but existing tasks are missing | Registration created an empty space. Sign out, enter the original space using its owner token, and bind an account there. If your chosen username is already used, choose another available name. There is currently no space-merging interface. |
| No “Set up an account for this space” form | Use the original owner token on the server website. Ordinary paired devices cannot bind an account. Already-bound spaces do not need this step, and the desktop has no binding form. |
| Computer connected, but no project on the phone | Check the server address and space, the desktop's selected projects, and the phone's selected project. A pairing code must also authorize that project. |
| Computer offline | Check that Seqivo is running, the computer is awake, and its network works. Check the desktop connection status, wait for sync to recover, then send new messages. |
| Create or send button disabled | Select a project, confirm the computer is online and the phone has operation permission. If another request awaits a receipt, wait or verify its result first. |
| Awaiting authorization | Check Codex login and execution on the computer. The phone has no interface to grant additional execution approvals. Do not repeatedly create the session. |
| Unknown submission result | Refresh the task and conversation output and check the computer before trying again, to avoid duplicate execution. |
| Wrong or forgotten password | Check username, address, and input. There is no email recovery. Retain the original owner token and contact the service administrator; registering repeatedly will not recover the old space. |
| Invalid pairing code | Check the intended device role, expiry, and whether it was already redeemed. Generate another code with the correct role. |

## 8. Change a password or revoke a device

After account login, use **Account (账号)** → **Change password (修改密码)**. Browsers must sign in again after the change.

Changing a password does not revoke paired devices. For lost or unused devices, open **Phone connection (手机连接)** → **Paired connections (已配对连接)** on the website, find the device, and select **Revoke (撤销)**.

Public deployments should use HTTPS and keep the server firewall enabled. Server administrators can still read stored tasks and conversations. Devices with operation permission can ask AI to modify authorized projects and may also request other files readable by the computer's user. Only authorize trusted devices for operation.

See [Accounts and remote conversations](accounts-and-conversations.en.md) for sync and security boundaries, and the [v0.3.0 validation report](accounts-conversations-validation.md) for verified and pending coverage.
