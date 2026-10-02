import * as path from 'path';
import Mocha from 'mocha';
import * as fs from 'fs';

export function run(): Promise<void> {
    const mocha = new Mocha({
        // The suites use suite()/test().
        ui: 'tdd',
        color: true,
        timeout: 120_000,
        // Just the tests matching it, e.g. MOCHA_GREP="marks sit" npm run test:integration.
        ...(process.env.MOCHA_GREP ? { grep: process.env.MOCHA_GREP } : {}),
    });

    const testsRoot = __dirname;
    const files = fs.readdirSync(testsRoot).filter(f => f.endsWith('.test.js'));

    for (const file of files) {
        mocha.addFile(path.resolve(testsRoot, file));
    }

    return new Promise((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} test(s) failed.`));
            } else {
                resolve();
            }
        });
    });
}
