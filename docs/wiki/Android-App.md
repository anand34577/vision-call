# Android App

The Android app gives you chat, one-to-one and group calls, and notifications for incoming calls and messages, without keeping a browser open. It needs Android 8.0 or newer.

You don't need the app to use Vision Call on a phone. Any phone browser works, and you can add the site to your home screen. The app is nicer for calls and notifications.

## Install

1. On the phone, open the [latest release](https://github.com/anand34577/vision-call/releases/latest) and download `visioncall_<version>_android.apk`.
2. Open the downloaded file. Android asks for permission to install apps from your browser or file manager the first time; allow it.
3. Tap **Install**.

Google Play Protect may warn that it doesn't recognise the app, because it isn't from the Play Store. Choose **Install anyway**.

## Connect to your server

When the app opens it asks for a **Server address**. The easiest choice is the plain HTTP port:

```
http://192.168.1.50:8080
```

Use your server's IP address instead of `192.168.1.50`. Then sign in with your username and password.

Why HTTP and not HTTPS? The app can make calls over plain HTTP, unlike a browser, and it avoids having to install the server's certificate on the phone. Your passwords and chat then travel unencrypted across your local network, although calls themselves are always encrypted. If you'd rather use HTTPS:

- With your own trusted certificate, enter `https://your-server-name:8443`.
- With the automatic self-signed certificate, first install it on the phone (see [HTTPS and Certificates](HTTPS-and-Certificates)), then enter `https://192.168.1.50:8443`.

To switch servers later, tap **Change** on the sign-in screen.

## Updates

Download the newer APK from the releases page and install it over the old one. Your sign-in and settings are kept. Every release is signed with the same key, so Android accepts the update.

## Check the download (optional)

Each APK has a matching `.sha256` file on the release page. To check the file on a computer:

```bash
sha256sum -c visioncall_v1.0.1_android.apk.sha256
```

## Permissions the app asks for

| Permission | Why |
|---|---|
| Camera and microphone | Video and voice calls |
| Notifications | Incoming calls and new messages |
| Full-screen notifications | Show an incoming call on the lock screen |
| Nearby devices | Use Bluetooth headsets during calls |
| Ignore battery optimisation | Stay connected in the background so calls and messages arrive on time |
| Restart after reboot | The app reconnects by itself after the phone restarts or the app updates |

Vision Call does not use Google's push service (FCM) or any other outside service, so it works the same on a closed network and on the internet. To stay reachable it keeps a connection to your server open in the background. If your phone's battery manager stops it anyway, the app also checks the server about every 15 minutes and shows an "unread messages" notification. Allowing the app to ignore battery optimisation is what keeps calls ringing instantly.
| Screen recording (only when you share) | Share your screen in a call |
