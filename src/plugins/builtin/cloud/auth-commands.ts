import type { GloomPluginContext } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { chatController } from "../chat/controller";
import { requestAuthDialog } from "./auth-dialog";
import { requestDeviceSignInDialog } from "./device-signin-dialog";

export function registerCloudAuthCommands(ctx: GloomPluginContext): void {
  ctx.registerCommand({
    id: "auth-login-qr",
    label: "Log In with QR Code",
    description: "Sign in by scanning a QR code with the Gloom app",
    keywords: ["login", "sign in", "qr", "scan", "device", "mobile", "phone", "app", "code"],
    category: "config",
    hidden: () => apiClient.isSignedIn(),
    execute: () => {
      const opened = requestDeviceSignInDialog({
        onSignedIn: () => ctx.showPane("chat"),
      });
      if (!opened) {
        ctx.notify({ body: "QR sign-in is not available right now.", type: "error" });
      }
    },
  });

  ctx.registerCommand({
    id: "auth-login",
    label: "Log In",
    description: "Log in to your Gloomberb account",
    keywords: ["login", "sign in", "auth", "account"],
    category: "config",
    hidden: () => apiClient.isSignedIn(),
    execute: () => {
      const opened = requestAuthDialog({
        mode: "login",
        onSignedIn: () => ctx.showPane("chat"),
      });
      if (!opened) {
        ctx.notify({ body: "Sign-in is not available right now.", type: "error" });
      }
    },
  });

  ctx.registerCommand({
    id: "auth-signup",
    label: "Sign Up",
    description: "Create a Gloomberb account",
    keywords: ["signup", "register", "create account"],
    category: "config",
    hidden: () => apiClient.isSignedIn(),
    execute: () => {
      const opened = requestAuthDialog({
        mode: "signup",
        onSignedIn: () => ctx.showPane("chat"),
      });
      if (!opened) {
        ctx.notify({ body: "Sign-up is not available right now.", type: "error" });
      }
    },
  });

  ctx.registerCommand({
    id: "auth-resend-verification",
    label: "Resend Verification Email",
    description: "Send another Gloom Cloud verification email",
    keywords: ["verify", "verification", "resend", "email"],
    category: "config",
    hidden: () => {
      const user = chatController.getSnapshot().user;
      return !apiClient.isSignedIn() || !user || user.emailVerified;
    },
    execute: async () => {
      await apiClient.sendVerification();
      ctx.notify({ body: "Verification email sent.", type: "success" });
    },
  });

  ctx.registerCommand({
    id: "auth-logout",
    label: "Logout",
    description: "Log out of your Gloomberb account",
    keywords: ["logout", "sign out"],
    category: "config",
    execute: async () => {
      if (!apiClient.isSignedIn()) {
        ctx.notify({ body: "Not logged in.", type: "error" });
        return;
      }
      let signOutError: unknown = null;
      try {
        await apiClient.signOut();
      } catch (error) {
        signOutError = error;
      }
      await chatController.refreshSession();
      await chatController.refreshMessages();
      ctx.notify({
        body: signOutError ? "Logged out locally. Cloud sign-out did not complete." : "Logged out.",
        type: "info",
      });
    },
    hidden: () => !apiClient.isSignedIn(),
  });
}
