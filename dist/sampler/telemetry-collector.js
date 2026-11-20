export class TelemetryCollector {
    totalRequests = 0;
    consoleErrors = [];
    failedRequests = [];
    visitedOrigins = new Set();
    constructor(page) {
        this.attach(page);
    }
    attach(page) {
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                try {
                    const u = new URL(frame.url());
                    if (u.protocol === 'http:' || u.protocol === 'https:') {
                        this.visitedOrigins.add(u.origin);
                    }
                }
                catch {
                    // ignore about:blank / data:
                }
            }
        });
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                this.consoleErrors.push({
                    type: 'console.error',
                    text: msg.text().slice(0, 300),
                    timestamp: new Date().toISOString(),
                });
            }
        });
        page.on('pageerror', (err) => {
            this.consoleErrors.push({
                type: 'pageerror',
                text: (err?.message || String(err)).slice(0, 300),
                timestamp: new Date().toISOString(),
            });
        });
        page.on('request', () => {
            this.totalRequests++;
        });
        page.on('requestfailed', (req) => {
            const errText = req.failure()?.errorText || 'request_failed';
            // Ignore benign aborted video/media range prefetches
            if (errText.includes('ERR_ABORTED'))
                return;
            this.failedRequests.push({
                url: req.url(),
                method: req.method(),
                failureText: errText,
            });
        });
        page.on('response', (res) => {
            const status = res.status();
            if (status >= 400) {
                this.failedRequests.push({
                    url: res.url(),
                    method: res.request().method(),
                    status,
                });
            }
        });
    }
    recordOrigin(urlStr) {
        try {
            const u = new URL(urlStr);
            if (u.protocol === 'http:' || u.protocol === 'https:') {
                this.visitedOrigins.add(u.origin);
            }
        }
        catch {
            // ignore
        }
    }
    getHealthReport() {
        return {
            totalRequests: this.totalRequests,
            failedRequestsCount: this.failedRequests.length,
            consoleErrorsCount: this.consoleErrors.length,
            visitedOrigins: [...this.visitedOrigins],
            recentConsoleErrors: this.consoleErrors.slice(-8),
            recentFailedRequests: this.failedRequests.slice(-8),
        };
    }
}
