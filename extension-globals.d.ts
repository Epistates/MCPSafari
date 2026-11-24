// Globals that Safari provides to the extension scripts and the DOM lib does
// not know about. Used only by the type check in tsconfig.json.
declare const browser: any;

// tldts, vendored in Resources/vendor and loaded as a classic script before
// background-cookies.js. Only the call that file makes is declared.
declare const tldts: {
    getPublicSuffix(
        hostname: string,
        options?: { allowPrivateDomains?: boolean; extractHostname?: boolean },
    ): string | null;
};

// Tool errors carry their code, whether to retry and what to do next as
// properties on the Error itself, which is how they cross every boundary up
// to the bridge reply (`failureResponse`).
interface Error {
    code?: string | number;
    retryable?: boolean;
    recoveryAction?: string;
    /** Set on `permission_required`: Safari is asking right now, not refusing. */
    permissionPending?: boolean;
}

// What the MAIN-world interceptors publish on the page's window, so a second
// injection finds the first and the content script can reach them.
interface Window {
    __mcpSafari?: any;
    __mcpConsoleInterceptorLoaded?: boolean;
    __mcpDialogInterceptorLoaded?: boolean;
    __mcpFileDropLoaded?: boolean;
    __mcpNetworkInterceptorLoaded?: boolean;
    __mcpTraceInterceptorLoaded?: boolean;
    __mcpGetConsoleMessages?: (...args: any[]) => any;
    __mcpGetNetworkRequests?: (...args: any[]) => any;
    __mcpGetPendingDialogs?: (...args: any[]) => any;
    __mcpHandleDialog?: (...args: any[]) => any;
    __mcpRecordTraceEvent?: (...args: any[]) => any;
    __mcpStartTrace?: (...args: any[]) => any;
    __mcpStopTrace?: (...args: any[]) => any;
}

// The network interceptor keeps each request's method and URL on the request.
interface XMLHttpRequest {
    __mcpMeta?: any;
}

// Safari 18.2 and later; the content script checks for it before use.
interface Uint8ArrayConstructor {
    fromBase64?(base64: string): Uint8Array<ArrayBuffer>;
}
