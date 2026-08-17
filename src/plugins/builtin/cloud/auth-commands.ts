import type { GloomPluginContext } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { chatController } from "../chat/controller";
import { requestDeviceSignInDialog } from "./device-signin-dialog";

export function registerCloudAuthCommands(ctx: GloomPluginContext): void {
  ctx.registerCommand({
    id: "auth-login-qr",
    label: "Log In with QR Code",
    description: "Sign in by scanning a QR code with the Gloom app",
    keywords: ["login", "sign in", "qr", "scan", "device", "mobile", "phone", "app", "code"],
    category: "config",
    hidden: () => !!apiClient.getSessionToken(),
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
    wizardLayout: "form",
    hidden: () => !!apiClient.getSessionToken(),
    wizard: [
      { key: "email", label: "Email", type: "text", placeholder: "email@example.com" },
      { key: "password", label: "Password", type: "password", placeholder: "Your password" },
      { key: "_validate", label: "Signing in...", type: "info", body: ["Connecting to Gloomberb...", "Logged in successfully!"] },
    ],
    execute: async (values) => {
      if (!values?.email || !values?.password) {
        throw new Error("Email and password are required");
      }
      const user = await apiClient.signIn(values.email, values.password);
      if (!user.emailVerified) {
        await apiClient.sendVerification().catch(() => {});
      }
      chatController.clearSession();
      await chatController.refreshSession();
      ctx.showPane("chat");
    },
  });

  ctx.registerCommand({
    id: "auth-signup",
    label: "Sign Up",
    description: "Create a Gloomberb account",
    keywords: ["signup", "register", "create account"],
    category: "config",
    wizardLayout: "form",
    hidden: () => !!apiClient.getSessionToken(),
    wizard: [
      { key: "email", label: "Email", type: "text", placeholder: "email@example.com" },
      {
        key: "username",
        label: "Username",
        type: "text",
        placeholder: "3-30 chars, starts with letter",
        body: ["Choose a username (3-30 characters, starts with a letter, alphanumeric and underscore only)"],
      },
      { key: "password", label: "Password", type: "password", placeholder: "Min 8 characters" },
      { key: "confirmPassword", label: "Confirm Password", type: "password", placeholder: "Re-enter password" },
      { key: "_validate", label: "Creating account...", type: "info", body: ["Registering with Gloomberb...", "Account created! Welcome to Gloomberb."] },
    ],
    execute: async (values) => {
      if (!values?.email || !values?.username || !values?.password) {
        throw new Error("All fields are required");
      }
      if (values.password !== values.confirmPassword) {
        throw new Error("Passwords do not match");
      }
      await apiClient.signUp(values.email, values.username, values.username, values.password);
      await apiClient.sendVerification();
      chatController.clearSession();
      await chatController.refreshSession();
      ctx.showPane("chat");
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
      return !apiClient.getSessionToken() || !user || user.emailVerified;
    },
    execute: async () => {
      await apiClient.sendVerification();
      ctx.notify({ body: "Verification email sent.", type: "success" });
    },
  });

  if (apiClient.getSessionToken()) {
    void chatController.refreshSession().catch(() => {});
  }

  ctx.registerCommand({
    id: "auth-logout",
    label: "Logout",
    description: "Log out of your Gloomberb account",
    keywords: ["logout", "sign out"],
    category: "config",
    execute: async () => {
      if (!apiClient.getSessionToken()) {
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
    hidden: () => !apiClient.getSessionToken(),
  });
}
