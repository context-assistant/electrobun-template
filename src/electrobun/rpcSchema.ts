export type UpdateInfo = {
  version: string;
  hash: string;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string;
};

export type AppRPCSchema = {
  bun: {
    requests: {
      updater_checkForUpdate: {
        params: {};
        response: UpdateInfo;
      };
      updater_downloadUpdate: {
        params: {};
        response: UpdateInfo;
      };
      updater_applyUpdate: {
        params: {};
        response: { ok: true };
      };
      updater_getUpdateInfo: {
        params: {};
        response: UpdateInfo | null;
      };

      secrets_get: {
        params: { key: string };
        response: { value: string | null };
      };
      secrets_set: {
        params: { key: string; value: string };
        response: { ok: true };
      };
      secrets_delete: {
        params: { key: string };
        response: { ok: boolean };
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      updater_updateInfoChanged: UpdateInfo;
    };
  };
};
