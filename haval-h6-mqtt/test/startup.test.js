const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

for (const scenario of ['email challenge', 'empty shared vehicle list']) {
    test('startup waits without exiting or polling stale vehicles: ' + scenario, async () => {
        const values = new Map([['vinList', 'OLDVIN']]);
        const timers = [], logs = [];
        let exits = 0, reads = 0, registrations = 0;
        const context = {
            process: { env: { REFRESH_TIME: '30', VIN: 'SYNTHETICVIN000001' }, exit: () => { exits++; } },
            console, Buffer,
            setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
            clearTimeout() {},
            require(name) {
                const mocks = {
                    './storage': { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) },
                    './schema': { validate: async () => {} },
                    './utils': { LogType: {}, printLog: (...args) => logs.push(args) },
                    './carConnector': { carData: {
                        async getCarList() {
                            if (scenario === 'email challenge') throw new Error('Preencha gwm_verification_code.');
                            return { data: { data: [] } };
                        },
                        async getCarInfo() { reads++; },
                    } },
                    './map': { sensorTopics: {}, attributeTopics: {} },
                    './mqtt': { mqttModule: { checkConnection: async () => {}, register: () => { registrations++; } },
                        EntityType: {}, ActionableAndLink: { onActionExecuted() {} } },
                    dotenv: { config() {} },
                    fs: { existsSync: () => true },
                };
                assert.ok(name in mocks, name);
                return mocks[name];
            },
        };
        const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
        vm.runInNewContext('(function () {\n' + source + '\n})()', context);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(values.get('Startup'), 'true');
        assert.equal(exits, 0);
        assert.equal(registrations, 0);
        assert.ok(logs.some(args => String(args).includes(scenario === 'email challenge' ? 'gwm_verification_code' : 'compartilhamento')));
        assert.ok(timers.length >= 2);
        // The recurring polling timer was scheduled before startup reached the challenge.
        await timers[0].callback();
        assert.equal(reads, 0);
    });
}
