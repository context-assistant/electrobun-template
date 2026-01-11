export {};

declare global {
  interface Window {
    __electrobunWebviewId?: number;
    __electrobunWindowId?: number;
    __electrobunRpcSocketPort?: number;

    // injected by Electrobun runtime; used internally by electrobun/view
    __electrobun?: {
      receiveMessageFromBun: (msg: unknown) => void;
      receiveInternalMessageFromBun: (msg: unknown) => void;
    };

    __electrobunBunBridge?: { postMessage: (msg: string) => void };
    __electrobunInternalBridge?: { postMessage: (msg: string) => void };

    __electrobun_decrypt?: (
      encryptedData: string,
      iv: string,
      tag: string,
    ) => Promise<string>;
  }
}
