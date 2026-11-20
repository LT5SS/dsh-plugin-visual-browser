import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const VALID_WINDOW_MODES = new Set([
    'visible-background',
    'minimized',
    'headless',
]);
/**
 * Resolves the effective window presentation mode in priority order:
 * 1. Explicit `opts.windowMode`
 * 2. `DSH_BROWSER_WINDOW_MODE` env var
 * 3. Legacy `opts.backgroundSilent` boolean (`true` -> `'headless'`, `false` -> `'visible-background'`)
 * 4. Default `'visible-background'` (visible non-popping window behind active app)
 */
export function resolveBrowserWindowMode(opts) {
    if (opts?.windowMode && VALID_WINDOW_MODES.has(opts.windowMode)) {
        return opts.windowMode;
    }
    const envMode = process.env.DSH_BROWSER_WINDOW_MODE?.trim();
    if (envMode && VALID_WINDOW_MODES.has(envMode)) {
        return envMode;
    }
    if (typeof opts?.backgroundSilent === 'boolean') {
        return opts.backgroundSilent ? 'headless' : 'visible-background';
    }
    return 'visible-background';
}
/**
 * Computes default right-half work-area coordinates so the visible background browser
 * sits cleanly beside/behind the user's active IDE/DSH window without overlapping awkwardly.
 */
export function computeDefaultBackgroundWindowBounds(workArea, overrides) {
    const workW = Math.max(800, workArea.right - workArea.left);
    const workH = Math.max(600, workArea.bottom - workArea.top);
    const width = overrides?.width ?? Math.max(760, Math.min(Math.round(workW * 0.5), workW - 24));
    const height = overrides?.height ?? Math.max(600, workH - 24);
    const x = overrides?.x ?? (workArea.right - width - 12);
    const y = overrides?.y ?? (workArea.top + 12);
    return { x, y, width, height };
}
async function findFreeLocalPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                server.close(() => reject(new Error('Failed to allocate free TCP port')));
                return;
            }
            const port = addr.port;
            server.close(() => resolve(port));
        });
    });
}
async function waitForCdpEndpoint(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
                signal: AbortSignal.timeout(1500),
            });
            if (res.ok) {
                const data = (await res.json());
                if (typeof data.webSocketDebuggerUrl === 'string' && data.webSocketDebuggerUrl.length > 0) {
                    return data.webSocketDebuggerUrl;
                }
            }
        }
        catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`Timed out waiting for Chrome CDP on port ${port}: ${String(lastErr?.message ?? lastErr ?? 'unknown')}`);
}
function escapePsSingleQuoted(value) {
    return value.replace(/'/g, "''");
}
function quoteWin32Arg(arg) {
    if (!/[\s"]/g.test(arg))
        return arg;
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
/**
 * Launches Chrome/Edge natively on Windows with STARTF_USESHOWWINDOW = SW_SHOWMINNOACTIVE (7),
 * then places its top-level HWND behind the user's current foreground window (`SW_SHOWNOACTIVATE` +
 * `SetWindowPos`) so it stays visibly monitorable without ever popping on top or stealing focus.
 */
export async function launchChromeNoActivateWin32(opts) {
    const cdpPort = await findFreeLocalPort();
    const ephemeralProfile = !opts.userDataDir;
    const userDataDir = opts.userDataDir ||
        path.join(os.tmpdir(), `dsh-visual-browser-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(userDataDir, { recursive: true });
    const chromeArgs = [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        ...(opts.extraArgs ?? []),
        '--new-window',
        'about:blank',
    ];
    const cmdLine = [quoteWin32Arg(opts.executablePath), ...chromeArgs.map(quoteWin32Arg)].join(' ');
    const overrideX = opts.windowBounds?.x ?? -999999;
    const overrideY = opts.windowBounds?.y ?? -999999;
    const overrideW = opts.windowBounds?.width ?? -1;
    const overrideH = opts.windowBounds?.height ?? -1;
    const showVisible = opts.windowMode === 'visible-background' ? 'true' : 'false';
    const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public static class DshNoActivateWin32 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessW(
    string lpApplicationName,
    string lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation
  );

  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, out RECT pvParam, uint fWinIni);
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr dpiContext);

  public static IntPtr FindMainChromeWindow(uint pid, int timeoutMs) {
    int waited = 0;
    while (waited < timeoutMs) {
      IntPtr found = IntPtr.Zero;
      EnumWindows((h, _) => {
        uint wpid = 0;
        GetWindowThreadProcessId(h, out wpid);
        if (wpid != pid) return true;
        if (GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
        if (!IsWindowVisible(h) && !IsIconic(h)) return true;
        var cls = new StringBuilder(64);
        GetClassName(h, cls, cls.Capacity);
        if (!cls.ToString().StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) return true;
        if (GetWindowTextLength(h) <= 0) return true;
        found = h;
        return false;
      }, IntPtr.Zero);
      if (found != IntPtr.Zero) return found;
      Thread.Sleep(40);
      waited += 40;
    }
    return IntPtr.Zero;
  }

  public static int[] Launch(
    string app,
    string cmdLine,
    bool showVisibleBackground,
    int overrideX,
    int overrideY,
    int overrideW,
    int overrideH
  ) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}

    RECT wa;
    SystemParametersInfo(0x0030, 0, out wa, 0);
    int workW = Math.Max(800, wa.Right - wa.Left);
    int workH = Math.Max(600, wa.Bottom - wa.Top);
    int w = overrideW > 0 ? overrideW : Math.Max(760, Math.Min((int)Math.Round(workW * 0.5), workW - 24));
    int h = overrideH > 0 ? overrideH : Math.Max(600, workH - 24);
    int x = overrideX > -999999 ? overrideX : (wa.Right - w - 12);
    int y = overrideY > -999999 ? overrideY : (wa.Top + 12);

    IntPtr prevFg = GetForegroundWindow();

    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = 0x00000001; // STARTF_USESHOWWINDOW
    si.wShowWindow = 7;      // SW_SHOWMINNOACTIVE

    PROCESS_INFORMATION pi;
    bool ok = CreateProcessW(app, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
    if (!ok) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    int pid = pi.dwProcessId;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    IntPtr hwnd = FindMainChromeWindow((uint)pid, 6000);
    if (showVisibleBackground && hwnd != IntPtr.Zero) {
      IntPtr insertAfter = (prevFg != IntPtr.Zero && IsWindow(prevFg) && prevFg != hwnd)
        ? prevFg
        : new IntPtr(1); // HWND_BOTTOM
      ShowWindow(hwnd, 4 /* SW_SHOWNOACTIVATE */);
      SetWindowPos(hwnd, insertAfter, x, y, w, h, 0x0010 | 0x0040 /* SWP_NOACTIVATE | SWP_SHOWWINDOW */);
      Thread.Sleep(250);
      insertAfter = (prevFg != IntPtr.Zero && IsWindow(prevFg) && prevFg != hwnd)
        ? prevFg
        : new IntPtr(1);
      if (GetForegroundWindow() == hwnd) {
        SetWindowPos(hwnd, insertAfter, x, y, w, h, 0x0010 /* SWP_NOACTIVATE */);
      }
    }

    return new int[] { pid, (int)hwnd.ToInt64(), x, y, w, h };
  }
}
"@
$res = [DshNoActivateWin32]::Launch(
  '${escapePsSingleQuoted(opts.executablePath)}',
  '${escapePsSingleQuoted(cmdLine)}',
  $${showVisible},
  ${overrideX},
  ${overrideY},
  ${overrideW},
  ${overrideH}
)
Write-Output ("{""pid"":" + $res[0] + ",""hwnd"":" + $res[1] + ",""x"":" + $res[2] + ",""y"":" + $res[3] + ",""width"":" + $res[4] + ",""height"":" + $res[5] + "}")
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    let launchedPid = 0;
    try {
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { timeout: 20000, windowsHide: true });
        const lines = stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith('{') && l.endsWith('}'));
        if (lines.length === 0) {
            throw new Error(`Unexpected Win32 launcher stdout: ${stdout.slice(0, 300)}`);
        }
        const parsed = JSON.parse(lines[lines.length - 1]);
        launchedPid = parsed.pid;
        const wsUrl = await waitForCdpEndpoint(cdpPort);
        return {
            pid: parsed.pid,
            hwnd: parsed.hwnd,
            cdpPort,
            wsUrl,
            userDataDir,
            ephemeralProfile,
            bounds: { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height },
        };
    }
    catch (err) {
        if (launchedPid > 0 || ephemeralProfile) {
            await terminateLaunchedChrome(launchedPid, userDataDir, ephemeralProfile).catch(() => { });
        }
        throw err;
    }
}
/**
 * Terminates a Win32-launched Chrome process tree and cleans up any ephemeral user-data-dir.
 */
export async function terminateLaunchedChrome(pid, userDataDir, ephemeralProfile) {
    if (pid > 0) {
        if (process.platform === 'win32') {
            try {
                await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                    timeout: 5000,
                    windowsHide: true,
                });
            }
            catch {
                try {
                    process.kill(pid);
                }
                catch {
                    /* already exited */
                }
            }
        }
        else {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch {
                /* already exited */
            }
        }
    }
    if (ephemeralProfile && userDataDir) {
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
        catch {
            /* ignore file-lock race on immediate close */
        }
    }
}
