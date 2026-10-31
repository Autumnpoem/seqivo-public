# Install and connect on a phone

[简体中文](mobile-install.zh-CN.md) · [Project overview](../README.en.md)

| Phone | Available now |
| --- | --- |
| Android 8.0 or later | Signed APK. The minimum SDK does not establish validation on every supported device. |
| iPhone | Safari and an optional Home Screen web app. There is no native IPA or App Store release. |

The phone is a remote client; Seqivo on the computer reads the local project files. Remote access requires a **HTTPS Hub with a valid certificate**, reachable by both devices. Installing an APK does not deploy a server or automatically upload projects. No official public Hub is provided. Local-only computer use requires no Hub.

## 1. Prepare the Hub and computer

For an existing Hub, ask its administrator for the HTTPS address, not an administrator token. To host your own, follow the [deployment guide](deployment.md). `https://board.example.com` below is a placeholder, not a working service.

1. Open your Hub in a browser and register or sign in as permitted by that server.
2. On the project computer, open Seqivo’s **手机连接** (“Phone connection”), enter the same Hub address, and sign in.
3. Explicitly select the projects to sync. Wait for the connection to succeed, then check the web project list.
4. Sign in with the same account on the phone and select the project to see synced tasks, evidence, and attention items. See the [account guide](account-setup.en.md) for pairing codes and permissions.

The computer must run Seqivo and remain online to sync new local AI progress; the AI must still report through the project instructions. The phone does not scan the computer or automatically read every AI chat. Remote Codex execution needs its own plugin setup and authorization. SSH connections made by the Hub to separate hosts do not depend on this computer being online.

## 2. Android installation

Public app version: **0.4.1, versionCode 15**, package ID `app.seqivo.android`. This is a release build with a dedicated publisher signature, debugging disabled, no test CA, and no preset server. It is not a Google Play listing.

1. Open the [public Release](https://github.com/Autumnpoem/seqivo-public/releases/tag/v0.4.1-r2) on the phone and download **[Seqivo-0.4.1-android.apk](https://github.com/Autumnpoem/seqivo-public/releases/download/v0.4.1-r2/Seqivo-0.4.1-android.apk)**.
2. Open the downloaded APK. If Android asks, allow installation from the browser or file manager handling this download; keep system security checks enabled. You can revoke that source’s install permission afterward.
3. Open Seqivo and enter your Hub’s **HTTPS origin**, such as `https://board.example.com`. Do not include paths, usernames, passwords, or access tokens.
4. Connect, sign in on the Hub page, then select a synced project. A fresh install does not inherit Chrome’s session.
5. Later launches use the saved address; sign in again if the session expires. Change the address using the app’s top-right menu.

If no projects appear, check that the computer uses the same Hub/account and has selected projects to sync. For connection errors, first confirm that the phone browser can reach the Hub. HTTP and invalid certificates are rejected; do not work around this by trusting an unknown certificate.

### Moving from an earlier test APK

Earlier debug v13/v14 packages use a different signing key and **cannot be updated in place** to the public APK. Confirm your Hub address and account credentials first, and finish or separately save unsent drafts. To switch, uninstall the old test app and install the public APK. Uninstalling clears this app’s local address, session, and drafts; it does not delete tasks already saved on the Hub. Clearing app data is not a routine update step.

Future public versions signed with the same key can update in place. See [Android’s signing documentation](https://developer.android.com/studio/publish/app-signing). File hashes are in the Release’s `SHA256SUMS.txt`; the public certificate and artifact checks are recorded in [release validation](android-public-release-results.json).

## 3. iPhone: Safari and Home Screen

1. Open your Hub HTTPS address in Safari, sign in, and select a project.
2. Use Safari’s Share button → **Add to Home Screen**. If iOS offers **Open as Web App**, enable it as desired, then add the icon.
3. Open Seqivo from its Home Screen icon next time. The web app may ask you to sign in separately; it uses the same Hub and account.

Exact controls depend on iOS; see [Apple’s instructions](https://support.apple.com/guide/iphone/iphea86e5236/ios). This is not a native iOS package and does not promise offline editing, persistent background execution, or notifications. Writes require a connection and user action; drafts are not automatically resent when the network returns.

## What was checked for this release

This delivery checks the Android release build, unit tests, lint, publisher signature, version metadata, legal files, and absence of private addresses and test certificates. Historical Android hardware/emulator and iPhone web tests retain their own version scope in the [Android history](android-app.md). The newly signed APK was not reinstalled on a physical phone for this publication; older debug-package results do not establish full acceptance of this APK.

For desktop source builds, see [Windows](build-windows.en.md) / [Ubuntu](build-ubuntu.en.md).
