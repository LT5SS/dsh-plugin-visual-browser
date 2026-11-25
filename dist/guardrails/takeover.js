import { safeEvaluate } from '../sampler/page-snapshot.js';
const DEFAULT_SENSITIVE_PATTERNS = [
    /\.bank\b/i,
    /paypal\.com/i,
    /stripe\.com\/checkout/i,
    /alipay\.com/i,
    /console\.cloud\.google\.com\/billing/i,
    /console\.aws\.amazon\.com\/billing/i,
];
/**
 * Inspects the current page DOM in a read-only manner to detect CAPTCHA / anti-bot gates,
 * payment checkout walls, or explicit login walls that require human takeover.
 * Never attempts to click through or bypass any gate.
 */
export async function detectPageGate(page, opts = {}) {
    const url = page.url();
    for (const pat of DEFAULT_SENSITIVE_PATTERNS) {
        if (pat.test(url)) {
            return {
                detected: true,
                reason: 'PAYMENT_REQUIRED',
                details: `Sensitive payment or billing domain detected (${url}). Human action required.`,
                url,
            };
        }
    }
    const domGate = await safeEvaluate(page, (checkLogin) => {
        const title = (document.title || '').toLowerCase();
        const bodyText = (document.body?.innerText || '').slice(0, 1500).toLowerCase();
        // 1. CAPTCHA / Anti-Bot gate detection (never solve or bypass!)
        const captchaSelectors = [
            'iframe[src*="challenges.cloudflare.com"]',
            'iframe[src*="google.com/recaptcha"]',
            'iframe[src*="hcaptcha.com"]',
            '.cf-turnstile',
            '.g-recaptcha',
            '.h-captcha',
            '[data-sitekey]',
            '[data-dsh-gate="captcha"]',
        ];
        for (const sel of captchaSelectors) {
            if (document.querySelector(sel)) {
                return {
                    detected: true,
                    reason: 'CAPTCHA_DETECTED',
                    details: `Anti-bot challenge or CAPTCHA element (${sel}) detected on page.`,
                };
            }
        }
        if (title.includes('just a moment') ||
            bodyText.includes('verify you are human') ||
            bodyText.includes('请完成人机验证')) {
            return {
                detected: true,
                reason: 'CAPTCHA_DETECTED',
                details: 'Human verification challenge page detected.',
            };
        }
        // 2. Payment / Checkout gate detection
        const paymentSelectors = [
            'input[autocomplete^="cc-"]',
            '[data-dsh-gate="payment"]',
            'iframe[src*="js.stripe.com"]',
        ];
        for (const sel of paymentSelectors) {
            if (document.querySelector(sel)) {
                return {
                    detected: true,
                    reason: 'PAYMENT_REQUIRED',
                    details: `Payment checkout element (${sel}) detected. Pausing for human completion.`,
                };
            }
        }
        // 3. Optional Login Wall detection
        if (checkLogin) {
            const pwdInput = document.querySelector('input[type="password"]:not([disabled]), [data-dsh-gate="login"]');
            if (pwdInput) {
                const style = window.getComputedStyle(pwdInput);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    return {
                        detected: true,
                        reason: 'LOGIN_REQUIRED',
                        details: 'Visible login / password authentication gate detected on page.',
                    };
                }
            }
        }
        return { detected: false };
    }, { detected: false }, { retries: 2, arg: opts.pauseOnLoginWall ?? true });
    if (domGate.detected && domGate.reason) {
        return {
            detected: true,
            reason: domGate.reason,
            details: domGate.details,
            url,
        };
    }
    return { detected: false, url };
}
export function buildApprovalCard(params) {
    const titleMap = {
        CAPTCHA_DETECTED: '🛑 检测到人机验证 (CAPTCHA) — 已暂停等待人工接管',
        PAYMENT_REQUIRED: '💳 检测到支付/结算页面 — 请人工确认操作',
        LOGIN_REQUIRED: '🔐 检测到登录认证页面 — 请完成登录后继续',
        SENSITIVE_DOMAIN_READONLY: '🛡️ 敏感站点只读保护触发',
        PROMPT_REQUIRES_HUMAN: '💬 页面弹出 prompt() 输入框 — 请人工处理',
        ORIGIN_BLOCKED: '🚫 目标域名已被宿主安全策略拦截',
        USER_TAKEOVER: '✋ 用户已手动接管 — 子代理已暂停',
    };
    return {
        cardType: 'DSH_BROWSER_TAKEOVER_CARD',
        subagentId: params.subagentId,
        role: params.role,
        reason: params.reason,
        url: params.url,
        screenshotPath: params.screenshotPath.replace(/\\/g, '/'),
        title: titleMap[params.reason],
        instructions: `${params.details || '页面需要人工介入。'}\n` +
            `子代理会话 (${params.subagentId}) 已在当前标签页原位挂起。请在浏览器面板完成相应操作后，调用 \`browser_subagent_resume\` 工具传入 \`subagent_id: "${params.subagentId}"\` 继续执行。`,
        resumeToolName: 'browser_subagent_resume',
    };
}
