const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const tls = require('tls');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { createGwmApi, createVehicleAgent, STATE_KEY } = require('../gwmApi');
const { signRequest } = require('../gwmSigning');

const BASE = 'https://br-app-gateway.gwmcloud.com/app-api/api/v1.0/';
const OK = data => ({ status: 200, data: { code: '000000', data } });
const FAIL = code => ({ status: 200, data: { code, description: 'private vendor description' } });
const jwt = exp => 'header.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.signature';
const tokens = (exp = 2000000000) => ({ accessToken: jwt(exp), refreshToken: 'refresh-one', gwId: 'gw-one' });

function memory() {
    const map = new Map();
    return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
}

function harness(sequence, store = memory(), code = '') {
    let time = 1795086000000;
    const calls = [];
    const mtls = { mtls: true };
    const options = {
        storage: store, username: 'test@example.invalid', password: 'Password com espaço!', verificationCode: code,
        now: () => time, vehicleAgentFactory: () => mtls,
        transport: { async request(config) {
            calls.push(config);
            assert.ok(sequence.length, `Unexpected request: ${new URL(config.url).pathname}`);
            const answer = sequence.shift();
            if (answer instanceof Error) throw answer;
            return typeof answer === 'function' ? answer(config) : answer;
        } },
    };
    return { api: createGwmApi(options), calls, mtls, store, options, advance: ms => { time += ms; } };
}

test('BR signature matches independent canonical reference, including query plus POST body', () => {
    for (const [method, url, body, parameters] of [
        ['GET', BASE + 'vehicle/getLastStatus?vin=SYNTHETICVIN000001&flag=true', undefined, 'flag=truevin=SYNTHETICVIN000001'],
        ['POST', BASE + 'vehicleCharge/setChargingPlan?vin=SYNTHETICVIN000001', '{"enable":false}', 'json={"enable":false}vin=SYNTHETICVIN000001'],
        ['POST', BASE + 'test?z=a%2Bb&empty=&a=%C3%A7', '{"password":"Espaço !"}', 'a=çempty=json={"password":"Espaço!"}z=a+b'],
    ]) {
        const raw = method + new URL(url).pathname + 'gwm-auth-appkey:9094558645'
            + 'gwm-auth-nonce:0123456789abcdefgwm-auth-timestamp:1795086000000'
            + parameters + 'ceffd90b9a8c8deeb82bc9963140aede';
        // Independent RFC percent-encoding implementation with Dart/JS safe characters.
        const escaped = [...Buffer.from(raw)].map(byte => /[A-Za-z0-9\-_.!~*'()]/.test(String.fromCharCode(byte))
            ? String.fromCharCode(byte) : '%' + byte.toString(16).toUpperCase().padStart(2, '0')).join('');
        const expected = crypto.createHash('sha256').update(escaped).digest('hex');
        assert.equal(signRequest(method, url, body, '1795086000000', '0123456789abcdef')['gwm-auth-sign'], expected);
    }
});

test('new app login uses plain password over verified TLS; status uses signed mTLS and identity', async () => {
    const h = harness([OK(tokens()), OK({ items: [] })]);
    const result = await h.api.get(BASE + 'vehicle/getLastStatus?vin=SYNTHETICVIN000001&flag=true');
    assert.equal(result.data.description, 'SUCCESS');
    const [login, read] = h.calls;
    assert.equal(login.url, 'https://br-h5-gateway.gwmcloud.com/app-api/api/v2.0/userAuth/loginWithPassword');
    assert.deepEqual(JSON.parse(login.data), {
        account: 'test@example.invalid', accountType: '2', countryCode: '55', agreement: [1, 2],
        password: 'Password com espaço!', deviceId: read.headers.deviceId, appType: '0', pushToken: null, country: 'BR',
    });
    assert.equal(login.httpsAgent.options.rejectUnauthorized, true);
    assert.equal(login.httpsAgent.options.cert, undefined);
    assert.equal(read.httpsAgent, h.mtls);
    assert.equal(read.headers.iccid, read.headers.deviceId);
    assert.equal(read.headers.gwId, 'gw-one');
    assert.equal(read.headers['User-Agent'], 'okhttp/4.9.3');
    for (const c of h.calls) {
        assert.equal(c.headers['gwm-auth-sign'], signRequest(c.method, c.url, c.data, c.headers['gwm-auth-timestamp'], c.headers['gwm-auth-nonce'])['gwm-auth-sign']);
        assert.equal(c.maxRedirects, 0);
        assert.equal(c.timeout, 30000);
    }
});

test('email challenge survives restart; code is checked then used to complete login', async () => {
    const h = harness([FAIL('308103'), OK(null)]);
    await assert.rejects(h.api.ensureSession(), { code: 'VERIFY_REQUIRED' });
    const device = JSON.parse(h.store.getItem(STATE_KEY)).deviceId;
    const request = JSON.parse(h.calls[1].data);
    assert.equal(request.type, '17');
    assert.equal(request.validCodeMode, 1);
    assert.equal(request.password, undefined);
    const pending = harness([], h.store);
    await assert.rejects(pending.api.ensureSession(), { code: 'VERIFY_REQUIRED' });
    assert.equal(pending.calls.length, 0);
    const resumed = harness([OK(null), OK(tokens())], h.store, '012345');
    await resumed.api.ensureSession();
    assert.ok(resumed.calls[0].url.endsWith('checkVerifyCode'));
    assert.equal(JSON.parse(resumed.calls[0].data).verifyCode, '012345');
    const login = JSON.parse(resumed.calls[1].data);
    assert.equal(login.deviceId, device);
    assert.equal(login.verifyCode, '012345');
    assert.equal(login.validCodeMode, '1');
    const saved = h.store.getItem(STATE_KEY);
    assert.ok(!saved.includes('012345') && !saved.includes('Password') && !saved.includes('test@example'));
    const reboot = harness([OK([])], h.store, '012345');
    await reboot.api.get(BASE + 'globalapp/vehicle/acquireVehicles');
    assert.equal(reboot.calls.length, 1);
    assert.ok(!reboot.calls[0].url.includes('userAuth'));
});

test('invalid code is not repeatedly submitted across restarts; replacement is accepted', async () => {
    const first = harness([FAIL('308103'), OK(null)]);
    await assert.rejects(first.api.ensureSession());
    const bad = harness([FAIL('308011')], first.store, '000000');
    await assert.rejects(bad.api.ensureSession(), { code: 'VERIFY_REQUIRED' });
    const same = harness([], first.store, '000000');
    await assert.rejects(same.api.ensureSession(), { code: 'VERIFY_REQUIRED' });
    assert.equal(same.calls.length, 0);
    const changed = harness([OK(null), OK(tokens())], first.store, '111111');
    await changed.api.ensureSession();
});

test('email is not resent on each poll and can be resent after ten minutes', async () => {
    const h = harness([FAIL('308103'), OK(null), FAIL('308103'), OK(null)]);
    await assert.rejects(h.api.ensureSession());
    await assert.rejects(h.api.ensureSession());
    assert.equal(h.calls.length, 2);
    h.advance(600001);
    await assert.rejects(h.api.ensureSession(), { code: 'VERIFY_REQUIRED' });
    assert.equal(h.calls.length, 4);
});

test('expiry renews tokens, preserves gwId if omitted, and persists rotation before read', async () => {
    const h = harness([OK(tokens(1795086400))]);
    await h.api.ensureSession();
    h.advance(100001);
    h.options.transport.request = async config => {
        h.calls.push(config);
        if (config.url.endsWith('/refreshToken')) return OK({ accessToken: jwt(2000000001), refreshToken: 'rotated-refresh' });
        assert.equal(JSON.parse(h.store.getItem(STATE_KEY)).tokens.refreshToken, 'rotated-refresh');
        return OK([]);
    };
    await h.api.get(BASE + 'globalapp/vehicle/acquireVehicles');
    const refresh = h.calls[1];
    assert.equal(refresh.url, 'https://br-h5-gateway.gwmcloud.com/app-api/api/v1.0/userAuth/refreshToken');
    assert.equal(refresh.httpsAgent, h.mtls);
    assert.equal(JSON.parse(refresh.data).deviceId.length, 32);
    assert.equal(h.calls[2].headers.gwId, 'gw-one');
    assert.equal(h.calls[2].headers.refreshToken, 'rotated-refresh');
});

test('simultaneous reads share a single login and a single rejected-token refresh', async () => {
    let logins = 0, refreshes = 0, readCount = 0;
    const h = harness([]);
    h.options.transport.request = async config => {
        await new Promise(resolve => setImmediate(resolve));
        if (config.url.endsWith('/loginWithPassword')) { logins++; return OK(tokens()); }
        if (config.url.endsWith('/refreshToken')) { refreshes++; return OK({ ...tokens(), accessToken: jwt(2000000002) }); }
        readCount++;
        return config.headers.accessToken === tokens().accessToken ? FAIL('570062') : OK([]);
    };
    await Promise.all([h.api.get(BASE + 'globalapp/vehicle/acquireVehicles'), h.api.get(BASE + 'globalapp/vehicle/acquireVehicles')]);
    assert.equal(logins, 1);
    assert.equal(refreshes, 1);
    assert.equal(readCount, 4);
});

test('607501 blocks further requests instead of taking the phone session', async () => {
    const h = harness([OK(tokens()), FAIL('607501')]);
    await assert.rejects(h.api.get(BASE + 'globalapp/vehicle/acquireVehicles'), { code: '607501' });
    await assert.rejects(h.api.get(BASE + 'globalapp/vehicle/acquireVehicles'), { code: '607501' });
    assert.equal(h.calls.length, 2);
    assert.equal(JSON.parse(h.store.getItem(STATE_KEY)).tokens, undefined);
});

for (const failure of [FAIL('570062'), FAIL('607501'), new Error('timeout with private request')]) {
    test('remote POST is sent once on session rejection or uncertain outcome: ' + (failure.data?.code || 'timeout'), async () => {
        const h = harness([OK(tokens()), failure]);
        await assert.rejects(h.api.post(BASE + 'vehicle/T5/sendCmd', { instructions: ['synthetic'], seqNo: 'sequence' }));
        assert.equal(h.calls.filter(c => c.url.endsWith('/sendCmd')).length, 1);
        assert.equal(h.calls.length, 2);
        assert.equal(JSON.parse(h.calls[1].data).seqNo, 'sequence');
    });
}

test('malformed refresh preserves saved tokens and never falls back to password', async () => {
    const h = harness([OK(tokens(1795086400)), OK({})]);
    await h.api.ensureSession();
    h.advance(100001);
    await assert.rejects(h.api.ensureSession(), { code: 'SCHEMA' });
    assert.equal(JSON.parse(h.store.getItem(STATE_KEY)).tokens.refreshToken, 'refresh-one');
    assert.equal(h.calls.length, 2);
});

test('definitively expired refresh can enter a new email verification flow', async () => {
    const h = harness([OK(tokens(1795086400)), FAIL('551011'), FAIL('308103'), OK(null)]);
    await h.api.ensureSession();
    h.advance(100001);
    await assert.rejects(h.api.ensureSession(), { code: 'VERIFY_REQUIRED' });
    assert.equal(JSON.parse(h.store.getItem(STATE_KEY)).tokens, undefined);
    assert.ok(h.calls[3].url.endsWith('getVerifyCode'));
});

test('bad password and HTTP 429 are throttled across polling and restart', async () => {
    for (const reply of [FAIL('308001'), { status: 429, headers: { 'retry-after': '600' }, data: 'private' }]) {
        const h = harness([reply]);
        await assert.rejects(h.api.ensureSession());
        const restarted = harness([], h.store);
        await assert.rejects(restarted.api.ensureSession());
        assert.equal(restarted.calls.length, 0);
    }
});

test('vehicle HTTP 429 respects Retry-After even with an otherwise valid session', async () => {
    const h = harness([OK(tokens()), { status: 429, headers: { 'retry-after': '600' } }, OK([])]);
    await assert.rejects(h.api.get(BASE + 'globalapp/vehicle/acquireVehicles'), { code: 'HTTP_429' });
    h.advance(300001);
    await assert.rejects(h.api.get(BASE + 'globalapp/vehicle/acquireVehicles'), { code: 'HTTP_429' });
    assert.equal(h.calls.length, 2);
    h.advance(300000);
    await h.api.get(BASE + 'globalapp/vehicle/acquireVehicles');
    assert.equal(h.calls.length, 3);
});

test('transport errors never expose passwords, token-bearing configs or server descriptions', async () => {
    const secretError = Object.assign(new Error('password: PRIVATE'), { config: { data: 'PRIVATE' }, code: 'ECONNRESET' });
    const h = harness([secretError]);
    await assert.rejects(h.api.ensureSession(), e => {
        assert.ok(!JSON.stringify(e).includes('PRIVATE') && !e.message.includes('PRIVATE'));
        assert.equal(e.config, undefined);
        return true;
    });
});

test('account or password changes invalidate tokens but retain device for same account', async () => {
    const h = harness([OK(tokens())]);
    await h.api.ensureSession();
    const previous = JSON.parse(h.store.getItem(STATE_KEY));
    createGwmApi({ ...h.options, password: 'new password' });
    const changed = JSON.parse(h.store.getItem(STATE_KEY));
    assert.equal(changed.tokens, undefined);
    assert.equal(changed.deviceId, previous.deviceId);
    createGwmApi({ ...h.options, username: 'other@example.invalid' });
    assert.notEqual(JSON.parse(h.store.getItem(STATE_KEY)).accountId, previous.accountId);
});

test('arbitrary hosts are rejected before login', async () => {
    const h = harness([]);
    await assert.rejects(h.api.get('https://example.invalid/'), { code: 'HOST' });
    assert.equal(h.calls.length, 0);
});

test('real bundled client chain loads in OpenSSL with full chain and server verification', () => {
    const agent = createVehicleAgent();
    assert.equal(agent.options.rejectUnauthorized, true);
    assert.equal(agent.options.ca, undefined);
    assert.equal(agent.options.minVersion, 'TLSv1.2');
    assert.ok((agent.options.cert.match(/BEGIN CERTIFICATE/g) || []).length >= 2);
    assert.doesNotThrow(() => tls.createSecureContext(agent.options));
    agent.destroy();
});

test('connector uses signed transport for discovery, status and climate commands', async () => {
    const requests = [];
    const storage = memory();
    const api = {
        ensureSession: async () => tokens(),
        get: async url => {
            requests.push({ method: 'GET', url });
            return { data: { description: 'SUCCESS', data: { items: [{ code: 'lock', value: '0' }, { code: 'ac', value: '0' }], hyEngSts: '0' } } };
        },
        post: async (url, body) => {
            requests.push({ method: 'POST', url, body });
            return { data: { description: 'SUCCESS' } };
        },
    };
    const sandbox = {
        module: { exports: {} }, process: { env: { USERNAME: 'synthetic', PASSWORD: 'synthetic', PIN: '1234' } },
        Buffer, console, setTimeout,
        require(name) {
            const mocks = {
                axios: {}, md5: () => 'hash', slugify: s => s.replaceAll(' ', '_'), './storage': storage,
                './carTextUtil': {}, './utils': { LogType: {}, printLog() {} },
                './map': { sensorTopics: { lock: { description: 'estado da trava' }, ac: { description: 'estado do ar condicionado' } } },
                './gwmApi': { createGwmApi: () => api },
            };
            return name in mocks ? mocks[name] : require(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../carConnector.js'), 'utf8'), sandbox);
    const connector = sandbox.module.exports;
    await connector.carData.getCarList();
    await connector.carData.getCarInfo('syntheticvin000001');
    const result = await connector.carUtil.airConditioner('1', 'syntheticvin000001', 23, 5);
    assert.equal(result.result, true);
    const command = requests.find(r => r.method === 'POST');
    assert.ok(command.url.endsWith('vehicle/T5/sendCmd'));
    assert.equal(command.body.securityPassword, 'hash');
    assert.equal(command.body.instructions['0x04'].airConditioner.temperature, '23');
    assert.equal(command.body.instructions['0x04'].airConditioner.operationTime, '5');
    assert.equal(command.body.instructions['0x04'].airConditioner.switchOrder, '1');
    assert.equal(requests.filter(r => r.method === 'POST').length, 1);
});
