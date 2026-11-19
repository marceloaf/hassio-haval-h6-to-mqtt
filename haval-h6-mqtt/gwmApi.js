// BR app authentication and transport. No remote commands are retried.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { signRequest } = require('./gwmSigning');

const AUTH_BASE = 'https://br-h5-gateway.gwmcloud.com/app-api/api/v2.0/userAuth/';
const REFRESH_URL = 'https://br-h5-gateway.gwmcloud.com/app-api/api/v1.0/userAuth/refreshToken';
const VEHICLE_BASE = 'https://br-app-gateway.gwmcloud.com/app-api/api/v1.0/';
const STATE_KEY = 'gwmAppSessionV2';
const APP_HEADERS = {
    rs: '2', terminal: 'GW_APP_GWM', brand: '6', language: 'pt_BR',
    systemtype: '2', regioncode: 'BR', country: 'BR', appid: '6',
    enterpriseid: 'CC01', channel: 'APP', cver: '1.4.2',
    'User-Agent': 'okhttp/4.9.3', Accept: 'application/json',
};
const EXPIRED_CODES = new Set(['570062', '551011', '551004', '551006', '607124']);
const VERIFY_ERRORS = new Set(['308011', '308012', '550002']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

class GwmError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'GwmError';
        this.code = code;
    }
}

function apiError(code) {
    const messages = {
        '308001': 'Conta ou senha recusada pela GWM (308001). Confira a conta exclusiva do HA.',
        '308103': 'Verificação por e-mail necessária (308103).',
        '607501': 'Sessão encerrada por login em outro dispositivo (607501). Saia dessa conta no aplicativo e reinicie o add-on. Use uma conta exclusiva para o HA.',
        '607012': 'A GWM recusou a assinatura da requisição (607012).',
        '570062': 'A GWM recusou a sessão do aplicativo (570062).',
        '551011': 'O refresh token foi recusado pela GWM (551011).',
    };
    // Never include vendor response descriptions: they may contain account information.
    return new GwmError(code, messages[code] || `A GWM recusou a requisição (código ${code}).`);
}

function createVehicleAgent(directory = path.join(__dirname, 'certs')) {
    const leaf = fs.readFileSync(path.join(directory, 'gwm_general.cer'), 'utf8');
    const bundle = fs.readFileSync(path.join(directory, 'gwm_root.cer'), 'utf8');
    const key = fs.readFileSync(path.join(directory, 'gwm_general.key'), 'utf8');
    // The intermediates must be SENT as part of cert, not just installed as ca.
    // Preserve system trust and hostname verification of the remote HTTPS server.
    return new https.Agent({
        cert: `${leaf.trim()}\n${bundle.trim()}\n`, key,
        rejectUnauthorized: true, minVersion: 'TLSv1.2',
        ciphers: 'DEFAULT:@SECLEVEL=0',
    });
}

function expiresSoon(token, now) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' && now >= payload.exp * 1000 - 300000;
    } catch {
        // Tokens with an unknown format remain subject to the server's validation.
        return false;
    }
}

function createGwmApi({ transport, storage, username, password, verificationCode = '',
    now = Date.now, vehicleAgentFactory = createVehicleAgent }) {
    username = String(username || '').trim();
    password = String(password || '');
    verificationCode = String(verificationCode || '').trim();
    const accountId = hash(username.toLowerCase());
    const credentialId = hash(JSON.stringify([username, password]));
    let state;
    try { state = JSON.parse(storage.getItem(STATE_KEY) || 'null'); } catch { state = null; }
    if (!state || state.accountId !== accountId || !/^[0-9a-f]{32}$/.test(state.deviceId || '')) {
        const legacyDevice = storage.getItem('deviceid');
        state = {
            accountId, credentialId,
            deviceId: /^[0-9a-f]{32}$/.test(legacyDevice || '') ? legacyDevice : crypto.randomBytes(16).toString('hex'),
        };
    } else if (state.credentialId !== credentialId) {
        state = { accountId, credentialId, deviceId: state.deviceId };
    }
    const save = () => storage.setItem(STATE_KEY, JSON.stringify(state));
    save();
    let vehicleAgent;
    let authPromise;
    let conflict = false;
    const loginAgent = new https.Agent({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });

    async function exchange(method, url, payload, tokens) {
        const body = payload === undefined ? undefined : JSON.stringify(payload);
        const authHost = url.startsWith(AUTH_BASE);
        if (!authHost && url !== REFRESH_URL && !url.startsWith(VEHICLE_BASE)) {
            throw new GwmError('HOST', 'Destino GWM inválido.');
        }
        const headers = {
            ...APP_HEADERS, deviceId: state.deviceId, iccid: state.deviceId,
            ...signRequest(method, url, body, String(now())),
        };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (tokens) Object.assign(headers, {
            accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, gwId: tokens.gwId,
        });
        if (!authHost && !vehicleAgent) vehicleAgent = vehicleAgentFactory();
        let response;
        try {
            response = await transport.request({
                method, url, headers, data: body,
                // The signature covers these exact bytes. Do not serialize again.
                transformRequest: [value => value],
                httpsAgent: authHost ? loginAgent : vehicleAgent,
                timeout: 30000, maxRedirects: 0, validateStatus: () => true,
            });
        } catch (error) {
            // Axios errors include the entire password/token-bearing request.
            const tls = /CERT|SSL|TLS|ISSUER/.test(String(error.code || ''));
            throw new GwmError(tls ? 'TLS' : 'NETWORK', tls
                ? 'Falha TLS na conexão com a GWM. Confira a cadeia de certificados.'
                : 'Falha de rede ou timeout na conexão com a GWM.');
        }
        if (response.status === 418) throw new GwmError('HTTP_418', 'A GWM bloqueou a requisição HTTP (418).');
        if (response.status === 429) {
            const retry = Number(response.headers?.['retry-after']);
            state.requestRetryAt = now() + Math.max(300, Number.isFinite(retry) ? retry : 300) * 1000;
            save();
            throw new GwmError('HTTP_429', 'Limite de requisições da GWM atingido (429). Aguarde antes de tentar novamente.');
        }
        if (response.status < 200 || response.status >= 300) {
            throw new GwmError(`HTTP_${response.status}`, `Falha HTTP ${response.status} na conexão com a GWM.`);
        }
        const envelope = response.data;
        if (!envelope || typeof envelope !== 'object' || typeof envelope.code !== 'string') {
            throw new GwmError('SCHEMA', 'Resposta inesperada da GWM; a sessão salva foi preservada.');
        }
        if (envelope.code === '607501') {
            conflict = true;
            delete state.tokens;
            save();
        }
        // Keep the connector's existing busy-message handling for remote commands.
        if (method === 'POST' && url.startsWith(VEHICLE_BASE) && ['9999', 'REMOTE250502'].includes(envelope.code)) {
            return response;
        }
        if (envelope.code !== '000000') throw apiError(envelope.code);
        // Preserve the interface used by carConnector.js without changing MQTT mappings.
        return { ...response, data: { ...envelope, description: 'SUCCESS' } };
    }

    function acceptTokens(data, previous) {
        const gwId = data?.gwId ?? previous?.gwId;
        if (!data || ![data.accessToken, data.refreshToken, gwId].every(v => typeof v === 'string' && v.length > 0)) {
            throw new GwmError('SCHEMA', 'Resposta de autenticação incompleta; a sessão salva foi preservada.');
        }
        state.tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken, gwId };
        delete state.pending;
        delete state.retryAt;
        delete state.lastError;
        save();
        return state.tokens;
    }

    function verificationBody(code) {
        const body = { type: '17', account: username, accountType: username.includes('@') ? '2' : '1',
            countryCode: '55', validCodeMode: 1 };
        if (code) body.verifyCode = code;
        else Object.assign(body, { operateCode: '', captchaType: '', captchaId: '', token: '' });
        return body;
    }

    function pendingError(invalid = false) {
        return new GwmError('VERIFY_REQUIRED', invalid
            ? 'Código de verificação recusado. Informe o código correto em gwm_verification_code, salve e reinicie o add-on.'
            : 'Código enviado por e-mail. Preencha gwm_verification_code nas opções do add-on, salve e reinicie. O código é temporário; remova-o após autenticar.');
    }

    async function passwordLogin() {
        if (!username || !password) throw new GwmError('CREDENTIALS', 'Configure gwm_username e gwm_password.');
        const codeId = verificationCode ? hash(verificationCode) : null;
        const usableCode = state.pending && codeId && codeId !== state.usedCodeId && codeId !== state.pending.triedCodeId;
        if (state.pending && !usableCode) {
            // Persist the challenge and rate limit across restarts. No email flood.
            if (now() - state.pending.requestedAt < 600000 || state.pending.triedCodeId === codeId && codeId) {
                throw pendingError(Boolean(state.pending.triedCodeId));
            }
            delete state.pending;
            save();
        }
        const body = {
            account: username, accountType: username.includes('@') ? '2' : '1', countryCode: '55',
            agreement: [1, 2], password, deviceId: state.deviceId, appType: '0', pushToken: null, country: 'BR',
        };
        if (usableCode) {
            // Mark before sending, so a restart never repeatedly submits a bad code.
            state.pending.triedCodeId = codeId;
            save();
            try {
                await exchange('POST', AUTH_BASE + 'checkVerifyCode', verificationBody(verificationCode));
            } catch (error) {
                if (VERIFY_ERRORS.has(error.code) || error.code === '308103') throw pendingError(true);
                // A transport failure did not prove the code invalid; permit a later retry.
                delete state.pending.triedCodeId;
                save();
                throw error;
            }
            Object.assign(body, { verifyCode: verificationCode, validCodeMode: '1' });
        }
        try {
            const response = await exchange('POST', AUTH_BASE + 'loginWithPassword', body);
            if (usableCode) state.usedCodeId = codeId;
            return acceptTokens(response.data.data);
        } catch (error) {
            if (error.code === '308103' && !usableCode) {
                // Write before sending: even an uncertain send must not trigger repeated emails.
                state.pending = { requestedAt: now() };
                save();
                await exchange('POST', AUTH_BASE + 'getVerifyCode', verificationBody());
                throw pendingError();
            }
            if (usableCode && (VERIFY_ERRORS.has(error.code) || error.code === '308103')) throw pendingError(true);
            if (usableCode && ['NETWORK', 'TLS', 'HTTP_429'].includes(error.code)) {
                delete state.pending.triedCodeId;
                save();
            }
            throw error;
        }
    }

    async function authenticate(rejected) {
        if (conflict) throw apiError('607501');
        if (state.requestRetryAt > now()) throw new GwmError('HTTP_429', 'Aguardando o limite de requisições da GWM (429).');
        if (state.retryAt > now()) throw new GwmError('COOLDOWN', state.lastError || 'Aguardando antes de tentar autenticar novamente.');
        if (state.tokens && state.tokens !== rejected && !expiresSoon(state.tokens.accessToken, now())) return state.tokens;
        try {
            if (state.tokens) {
                const previous = state.tokens;
                try {
                    const response = await exchange('POST', REFRESH_URL, {
                        accessToken: previous.accessToken, refreshToken: previous.refreshToken, deviceId: state.deviceId,
                    }, previous);
                    return acceptTokens(response.data.data, previous);
                } catch (error) {
                    if (error.code === '607501') throw error;
                    if (!EXPIRED_CODES.has(error.code) && !['HTTP_401', 'HTTP_403'].includes(error.code)) throw error;
                    delete state.tokens;
                    save();
                }
            }
            return await passwordLogin();
        } catch (error) {
            if (error.code === '607501') {
                conflict = true;
                delete state.tokens;
            } else if (error.code !== 'VERIFY_REQUIRED') {
                // Throttle credentials, rate limits and transient auth failures, including across restarts.
                state.retryAt = now() + (error.code === '308001' || error.code === 'HTTP_429' ? 300000 : 30000);
                state.lastError = error.message;
            }
            save();
            throw error;
        }
    }

    async function ensureSession(rejected) {
        if (!authPromise) {
            authPromise = authenticate(rejected).finally(() => { authPromise = undefined; });
        }
        return authPromise;
    }

    async function request(method, url, payload) {
        // Validate BEFORE authentication; never send credentials for a caller's arbitrary URL.
        if (!url.startsWith(VEHICLE_BASE)) throw new GwmError('HOST', 'Destino GWM inválido.');
        const tokens = await ensureSession();
        try {
            return await exchange(method, url, payload, tokens);
        } catch (error) {
            if (error.code === '607501') {
                conflict = true;
                delete state.tokens;
                save();
            }
            // Only idempotent reads can be retried after a definitive session rejection.
            if (method === 'GET' && (EXPIRED_CODES.has(error.code) || ['HTTP_401', 'HTTP_403'].includes(error.code))) {
                return exchange(method, url, payload, await ensureSession(tokens));
            }
            throw error;
        }
    }

    return {
        ensureSession,
        get: url => request('GET', url),
        post: (url, payload) => request('POST', url, payload),
    };
}

module.exports = { createGwmApi, createVehicleAgent, expiresSoon, GwmError, STATE_KEY };
