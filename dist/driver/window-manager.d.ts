import type { BrowserSessionOptions, BrowserWindowBounds, BrowserWindowMode } from './types.js';
/**
 * Resolves the effective window presentation mode in priority order:
 * 1. Explicit `opts.windowMode`
 * 2. `DSH_BROWSER_WINDOW_MODE` env var
 * 3. Legacy `opts.backgroundSilent` boolean (`true` -> `'headless'`, `false` -> `'visible-background'`)
 * 4. Default `'visible-background'` (visible non-popping window behind active app)
 */
export declare function resolveBrowserWindowMode(opts?: Pick<BrowserSessionOptions, 'windowMode' | 'backgroundSilent'>): BrowserWindowMode;
/**
 * Computes default right-half work-area coordinates so the visible background browser
 * sits cleanly beside/behind the user's active IDE/DSH window without overlapping awkwardly.
 */
export declare function computeDefaultBackgroundWindowBounds(workArea: {
    left: number;
    top: number;
    right: number;
    bottom: number;
}, overrides?: BrowserWindowBounds): {
    x: number;
    y: number;
    width: number;
    height: number;
};
export interface LaunchedWin32Browser {
    pid: number;
    hwnd: number;
    cdpPort: number;
    wsUrl: string;
    userDataDir: string;
    ephemeralProfile: boolean;
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
/**
 * Launches Chrome/Edge natively on Windows with STARTF_USESHOWWINDOW = SW_SHOWMINNOACTIVE (7),
 * then places its top-level HWND behind the user's current foreground window (`SW_SHOWNOACTIVATE` +
 * `SetWindowPos`) so it stays visibly monitorable without ever popping on top or stealing focus.
 */
export declare function launchChromeNoActivateWin32(opts: {
    executablePath: string;
    windowMode: 'visible-background' | 'minimized';
    windowBounds?: BrowserWindowBounds;
    userDataDir?: string;
    extraArgs?: string[];
}): Promise<LaunchedWin32Browser>;
/**
 * Terminates a Win32-launched Chrome process tree and cleans up any ephemeral user-data-dir.
 */
export declare function terminateLaunchedChrome(pid: number, userDataDir?: string, ephemeralProfile?: boolean): Promise<void>;
