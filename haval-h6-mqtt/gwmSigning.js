// BR protocol ported from moryoav/ha-gwm-ev, commit f771372 (MIT).
// See THIRD_PARTY_NOTICES.md for attribution and license.
const crypto = require('crypto');

const APP_KEY = '9094558645';
const APP_SECRET = 'ceffd90b9a8c8deeb82bc9963140aede';

function signRequest(method, url, body, timestamp = String(Date.now()), nonce = crypto.randomBytes(8).toString('hex')) {
    const target = new URL(url);
    const parameters = Object.fromEntries(target.searchParams);
    if (method === 'POST' && body !== undefined) parameters.json = body;
    const canonical = Object.keys(parameters).sort()
        .map(key => `${key}=${parameters[key].replaceAll(' ', '')}`).join('');
    const auth = `gwm-auth-appkey:${APP_KEY}gwm-auth-nonce:${nonce}gwm-auth-timestamp:${timestamp}`;
    const raw = method + target.pathname + auth + canonical + APP_SECRET;
    const sign = crypto.createHash('sha256').update(encodeURIComponent(raw)).digest('hex');
    return {
        'gwm-auth-appkey': APP_KEY,
        'gwm-auth-nonce': nonce,
        'gwm-auth-timestamp': timestamp,
        'gwm-auth-sign': sign,
    };
}

module.exports = { signRequest };
